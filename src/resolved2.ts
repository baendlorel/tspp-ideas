
declare function fetchJson(url: string): Promise<any>;
declare function sideEffect(tag: string): any;
/**
 * case01 【无解】调用点所在的语法位置不能 await
 *
 * 方案第 3 步需要在调用处写 `b = await e`，但下面这些位置不允许 await，
 * 而且也不能像普通函数那样“顺手改成 async”，因为会改变它们的签名 / 调用约定：
 *   - getter / setter、Symbol.iterator、toString / valueOf / toJSON 等被引擎隐式调用的方法
 *   - 类实例字段初始化器、static 块（static 块里禁止 await）
 *   - 另一个类的同步 constructor（组合而不是继承：`constructor() { this.a = new A() }`）。
 *     要让它能 await 只能把它也变成 async constructor，也就是 async 沿着“谁 new 了谁”一路传染
 *   - 参数默认值（所在函数不是 async 时）
 *   - sort 比较函数、Proxy trap 等同步回调
 * 不继承也躲不开：只要 async 类被别的同步代码持有，传染就会发生。
 */
async function case01_syncContexts() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  class Holder {
    inst = new A(); // 字段初始化器里没法 await
    get lazy() {
      return new A(); // getter 不能是 async
    }
    static {
      new A(); // static 块里禁止 await
    }
    constructor(public other = new A()) {} // 同步构造函数的参数默认值
  }
  new Holder();
}
// ?? 这里本来就不许用，这是庸人自扰

/**
 * case02 【方案缺陷】new A() 出现在表达式中间：求值顺序、短路、链式调用
 *
 * class.ts 的 try/catch 模板是“语句级”的，只能处理 `x = new A()` 这种形态。
 * 表达式位置需要把整个表达式拆开成临时变量（保持从左到右的求值顺序），或者包成 IIFE/辅助函数：
 *   - f(sideEffect('1'), new A(), sideEffect('2'))   // 参数求值顺序
 *   - cond && new A() / cond ? new A() : null / x ??= new A()  // 短路：不能提前构造
 *   - new A().method()  /  new A()?.prop             // 成员访问作用在 promise 上还是实例上？
 *   - () => new A()                                  // 箭头函数简写体，需改成 async 或返回 promise
 *   - `${new A()}`、for 条件、yield new A() 等
 * 每一种都要单独设计改写规则，且 await 提升之后很容易改变原本的求值时序。
 */
async function case02_expressionPosition(cond: boolean, f: (...a: any[]) => any) {
  class A {
    v = 1;
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  f(sideEffect('1'), new A(), sideEffect('2'));
  const x = cond && new A();
  const y = (await new A()).v + (await new A()).v;
  const z = [1, 2].map(() => new A());
  return [x, y, z];
}
// ?? 纯粹的new A它就是一个Promise，没别的，它就和Promise行为一样。这是正常现象


/**
 * case03 【语义偏差】不 await 的 new：并发 / 保存 promise / 竞速
 *
 * 原生提案里 `new A()` 的值就是 Promise<A>，所以下面这些都是合法且有意义的写法。
 * 但 class.ts 的调用点模板固定写 `b = await e`，等于把每个 `new A()` 都强制变成“立即 await”：
 *   - Promise.all([new A(), new B()]) 从并发变成串行
 *   - const p = new A(); doOther(); await p;  顺序被打乱，doOther 被推迟到 A 构造完成之后
 *   - new A();  fire-and-forget，会被迫等待
 *   - Promise.race / allSettled / .then / .catch 链
 * 修复思路：catch 里直接返回 e（promise）而不是 await e，让 `new A()` 降级成“值是 promise 的表达式”，
 * 这样 await 由用户自己写的 await 负责，也顺带消除 case01 中大部分“不能 await”的问题。
 * 但那样 class.ts 里的 `b = await e` 这一步就需要重写，整个模板的语义都要改。
 */
async function case03_concurrency() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  class B {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/b');
    }
  }
  const [a, b] = await Promise.all([new A(), new B()]);
  const p = new A();
  sideEffect('must run before A finishes');
  await p;
  return [a, b];
}
// ?? 改用了constructAsync




/**
 * case04 【无解】编译期无法确定“这个 new 是不是 async 构造”
 *
 * 降级需要在每个 `new X()` 处插入 try/catch，但并不是所有调用点都能被识别：
 *   - 单文件转译（isolatedModules）：import 进来的类是否 async 看不到
 *   - 泛型 / 构造签名：function make<T>(C: new () => T) { return new C() }
 *   - 动态：new (await import('./x')).default()、new this.constructor()、Reflect.construct()
 *   - 第三方库 / 框架代码：DI 容器、ORM、序列化库、React 等内部的 new —— 它们不会经过本编译器
 *   - Proxy 的 construct 转发
 * 这些位置会直接收到一个被抛出的 promise，表现为一个莫名其妙的异常（并伴随 case15 的未处理 rejection）。
 *
 * 退而求其次是“所有 new 都包 try/catch”，代价：
 *   - 全部代码都要被改写、并且体积和性能受影响（case16）
 *   - class.ts 的模板在 new 正常返回（类不是 async）时 b 永远不会被赋值，
 *     必须写成 try { b = new X() } catch (e) { if (has(e)) b = await e; else throw e }
 *   - 非 async 类的 new 也被改写成 await 之后，结果类型会从 T 变成 Promise<T> 还是 T？
 *     两种返回形态混在同一个表达式里，调用方无法静态区分
 */
async function case04_unknownCallSite<T>(C: new () => T, Dyn: any) {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  const viaGeneric = new C();
  const viaReflect = Reflect.construct(A, []);
  const viaDynamic = new Dyn();
  return [viaGeneric, viaReflect, viaDynamic];
}
// ?? 这本来就不知道啊，谁写的谁还不知道吗



/**
 * case06 【无解】类型系统：new A() 的类型是 A，而不是 Promise<A>
 *
 * 降级只发生在 JS 输出阶段，类型检查仍然把 `new A()` 当作 A：
 *   - InstanceType<typeof A>、ConstructorParameters 等工具类型
 *   - 构造签名 `new () => T` 的结果是 T，但实际应该是 Promise<T>；
 *     因此需要一套新的 `async new () => T` 签名，并改写所有现有的泛型工具
 *   - .d.ts 输出：declaration: true 时需要把 async constructor 表达出来
 *   - class 实现 interface 时，构造签名无法参与 implements 检查
 * 这些都不是降级编译方案能解决的，需要类型系统一起配套修改。
 */
async function case06_types() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  type Inst = InstanceType<typeof A>; // 期望 Promise<A>，实际 A
  const make = <T,>(C: new () => T): T => new C(); // 期望 Promise<T>
  const a: A = await make(A); // 类型上通过，但语义已经对不上
  return [a] as [Inst];
}

// ?? 这不是问题