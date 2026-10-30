/**
 * async constructor 降级方案（class.ts）无法囊括的边界情况
 * 提案写法见 normal.ts，降级结果见 class.ts
 *
 * 评估基准（class.ts 当前方案）
 *   1. 构造函数体提取成类外的 `async function constructX(this: any, args)`
 *   2. 子类：不再 extends 父类，constructSub 里 `await constructParent.call(this, args)` 代替 `await super(args)`
 *   3. 原 constructor 只做 `throw raw`（raw = constructX.call(this).then(() => this)），raw 登记在 globalContainer
 *   4. 调用点 try { new X() } catch (e) { if (globalContainer.has(e)) b = await e; else throw e }
 *
 * 标记说明
 *   【无解】     在“构造函数抛出 promise”这一机制下，语义上无法等价降级
 *   【方案缺陷】 class.ts 中描述的方案没有覆盖，但可通过扩展编译规则修复（case 里会写修复思路和代价）
 *   【语义偏差】 能编译通过，但行为与原生 async constructor 提案不一致
 *   （标注“已验证”的结论用 node 实测过，其余是根据语言规范推断）
 *
 * 每个 case 先用提案语法写出原始代码（// @ts-expect-error 是因为 TS 不认识 async constructor），
 * 再在注释里说明降级后会发生什么。本文件只做记录，不会被执行。
 *
 * 目录
 *   A. 继承                         case01 ~ case09
 *   B. 调用点（new A() 所在位置）    case10 ~ case15
 *   C. 构造函数体提取                case16 ~ case21
 *   D. 降级产物的运行时行为          case22 ~ case25
 */

declare function fetchJson(url: string): Promise<any>;
declare function sideEffect(tag: string): any;

/* ========================================================================== *
 * A. 继承
 * ========================================================================== */

/**
 * case01 【方案缺陷】同步子类（含隐式构造函数）继承 async 父类
 *
 * class.ts 只演示了“async 子类 extends async 父类”。下面两种子类没有 async 标记，没有入口：
 *   - 显式同步构造函数 `constructor() { super(); ... }`
 *   - 隐式构造函数 `class C extends A {}`
 * 如果按普通类降级，`super()` 会抛出 A 的 raw，子类构造函数 super() 之后的代码整个被跳过，
 * 异常穿过 new B() 直接离开，B 的字段也没装。
 *
 * 提案本身要先规定：(a) 编译错误（必须显式写 async constructor），还是 (b) 自动“传染”成 async。
 * 选 (b) 时，编译器要把 B 合成为 `async constructor() { await super(); ...原函数体 }` 再按 class.ts 降级。
 * 代价：B 的对外契约从同步变成异步，所有 `new B()` 都要跟着改写（case10 ~ case13）；
 * 如果 B 在另一个没有被本编译器处理的包里，传染不到（case08）。
 */
async function case01_syncSubclass() {
  class A {
    data: any;
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      this.data = await fetchJson('/a');
    }
  }
  class B extends A {
    len = 0;
    constructor() {
      super();
      this.len = this.data.length; // 降级后：永远不会执行
    }
  }
  class C extends A {} // 隐式构造函数，没有任何地方可以放 async
  await new B();
  await new C();
}

/**
 * case02 【方案缺陷】父类的实例字段 / #私有成员没有被安装到子类实例上（已验证）
 *
 * constructASub 里调用的是 constructA（A 的构造函数体），并没有执行 class A 的构造函数，
 * 所以 A 里的字段初始化器、#私有字段、#私有方法都不会出现在 ASub 的实例上：
 *   - 公开字段：编译器可以把初始化器也提取进 constructA（按顺序 defineProperty）
 *   - #私有字段 / #私有方法：只能由 A 自己的构造过程安装，外部无法补装。
 *     实测 `new ASub().getX()` 抛 TypeError: Cannot read private member #x from an object whose class did not declare it
 *
 * 修复需要推翻“子类去掉 extends”这个设计（已验证可行）：
 *   保留 extends，super(...) 前置位一个模块级标记，让 A 的 constructor 看到标记时“只装字段、不执行 async 体、不 throw”，
 *   然后子类自己再 throw raw。这样父类 #私有字段、instanceof、static 继承都正常（case03）。代价：
 *   - 标记必须在 super 的“参数求值之后”才能置位，否则参数里另一个 `new X()` 会误吃标记（已验证）
 *   - 多级继承需要逐层透传标记
 *   - 父类必须是同一编译器的产物（case08）
 *   - 子类的 this 在 super() 之后才存在，constructSub.call(this) 的位置被限制
 */
async function case02_parentFieldsLost() {
  class A {
    pub = 'A.pub';
    #x = 1;
    #secret() {
      return this.#x;
    }
    getX() {
      return this.#secret();
    }
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  class ASub extends A {
    sub: any;
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await super();
      this.sub = 3;
    }
  }
  const s = await new ASub();
  s.getX(); // 降级后：TypeError；s.pub 也是 undefined
}

/**
 * case03 【方案缺陷】去掉 extends 后，原型链 / 静态继承 / instanceof / super.method 全部丢失
 *
 * class.ts 的 `class ASub { ... }` 没有 extends，实例原型链是 ASub.prototype -> Object.prototype：
 *   - `asub instanceof A` 为 false
 *   - A.prototype 上的方法在 asub 上不存在
 *   - ASub.s（A 的静态成员）不存在
 *   - ASub 自己方法里的 `super.hi()` 因为 HomeObject 的原型是 Object.prototype 而抛 TypeError
 *   - Object.getPrototypeOf(ASub) !== A，TS 的 declaration 输出与运行时不一致
 * 修复：降级时补 Object.setPrototypeOf(ASub, A) 和 Object.setPrototypeOf(ASub.prototype, A.prototype)
 * （已验证 instanceof、静态成员、super.method() 都恢复）。代价：setPrototypeOf 会让引擎放弃部分优化，
 * 并且 A 是跨文件 / 动态值时需要在运行期才能确定（case08）。
 * 保留 extends 的方案（case02）则天然没有这个问题。
 */
async function case03_prototypeChain() {
  class A {
    static s = 'static';
    hi() {
      return 'a';
    }
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  class ASub extends A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await super();
    }
    override hi() {
      return 'sub>' + super.hi(); // 降级后：TypeError: (intermediate value).hi is not a function
    }
  }
  const s = await new ASub();
  return [s instanceof A, ASub.s, s.hi()];
}

/**
 * case04 【语义偏差】字段初始化顺序与“重新声明字段”（已验证）
 *
 * 原生顺序：父类字段 -> 父类构造体 -> 子类字段 -> 子类构造体。
 * 降级后 ASub 是独立类，字段在 `new ASub()` 一开始就初始化，而父类构造体在 throw 之后才异步执行：
 *   子类字段 -> 父类构造体 -> 子类构造体
 * 后果：
 *   - 子类字段覆盖父类字段：原生 x === 'child'，降级后被父类构造体写回 'parent'（实测）
 *   - 子类字段初始化器依赖父类构造体的结果（`len = this.data.length`）：原生 OK，降级后 data 还是 undefined，直接 TypeError
 *   - 子类重新声明字段 `override data;`（useDefineForClassFields，target: es2023）：原生把它重置为 undefined，
 *     降级后反而保留了父类构造体写入的值
 * 修复：把子类的公开字段初始化器挪到 constructSub 里 `await constructParent` 之后（defineProperty 补装）。
 * #私有字段本身必须在构造期声明，只能“声明留在类里、初始化表达式挪到 constructSub 里再赋值”，
 * 这又要求 constructSub 能访问 #私有名（case16）。
 */
async function case04_fieldOrder() {
  class P {
    x = 'p-init';
    data: any;
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      this.data = await fetchJson('/p');
      this.x = 'parent';
    }
  }
  class C extends P {
    override x = 'child'; // 原生：'child'；降级后：'parent'
    len = this.data.length; // 原生：OK；降级后：TypeError
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await super();
    }
  }
  await new C();
}

/**
 * case05 【方案缺陷】父类不是 async：同步类 / 内建类 / DOM 类 / 第三方类（已验证）
 *
 * 提案里 `await super(args)` 对同步父类也必须合法（await 一个非 promise）。
 * 但降级成 `parent.call(this, args)` 需要父类有 constructParent：
 *   - 普通 class 被 .call：TypeError: Class constructor SyncP cannot be invoked without 'new'
 *   - Map.call(this)：TypeError: Constructor Map requires 'new'
 *   - Error.call(this, 'm')：不抛，但完全不碰 this（own keys 为 0，message 为 undefined），静默错误
 *   - HTMLElement / EventTarget / Promise 等内部槽只能由 new 创建，自定义元素还由浏览器解析器负责 new
 * 修复 1：`Reflect.construct(Parent, args, new.target)` 拿到真实实例，再把函数体里的 `this` 全部改写成这个局部变量，
 *   最终 resolve 它。代价：子类自己的字段/#私有字段装在被丢弃的原 this 上，需要另行处理；
 *   this 在 await 之前被泄漏（登记到注册表）的情况会指向错误对象。
 * 修复 2：保留 extends（case02），同步父类的 `super(args)` 就是普通调用，不需要特殊处理。
 * 无论哪种，编译器都要在“父类是 async 还是同步”之间做选择，而这在编译期往往不可知（case08），只能运行期探测。
 */
async function case05_syncParent() {
  class MyError extends Error {
    code: any;
    // @ts-expect-error
    async constructor(msg: string) {
      // @ts-expect-error
      await super(msg);
      // @ts-expect-error
      this.code = await fetchJson('/code');
    }
  }
  class MyMap extends Map<string, string> {
    ready = false;
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await super();
      this.ready = true;
    }
  }
  await new MyError('x');
  await new MyMap();
}

/**
 * case06 【方案缺陷】提取函数里无法使用 super.xxx（已验证 SyntaxError）
 *
 * `super.method()` / `super.prop` / `super[expr]` 依赖 HomeObject，只能出现在 class 体内的方法里。
 * 提取到类外的 `async function constructD` 里写这个会得到 SyntaxError: 'super' keyword unexpected here。
 * 需要把它改写成 `Object.getPrototypeOf(D.prototype).greet.call(this)`（还要处理 super.x = v、
 * 箭头函数里的 super、带 getter 的情况；且依赖 case03 的原型链被补好）。
 * 或者不提取到类外，而是提取成类内的方法（case16），这样 super.xxx 原样可用。
 */
async function case06_superMember() {
  class Base {
    greet() {
      return 'base';
    }
  }
  class D extends Base {
    msg: any;
    // @ts-expect-error
    async constructor() {
      super();
      // @ts-expect-error
      this.msg = (await fetchJson('/m')) + super.greet();
    }
  }
  await new D();
}

/**
 * case07 【语义偏差】派生类 super() 的约束全部消失（部分已验证）
 *
 * 降级后的 constructSub 是普通 async 函数，`this` 一开始就可用，原生 derived constructor 的这些检查就没了：
 *   - super() 之前访问 this：原生 ReferenceError: Must call super constructor in derived class before accessing 'this'（已验证），
 *     降级后静默通过
 *   - 不调用 super()：原生 ReferenceError，降级后静默通过，父类构造体根本没跑
 *   - 调用两次 super()：原生 ReferenceError: Super constructor may only be called once，降级后父类构造体跑两遍
 *   - super() 放在条件分支 / try / 箭头函数里：编译器要保留原控制流，不能简单地“找到那一句替换掉”
 * 这些在原生里都是运行期错误，降级后变成“能跑但行为不对”，且不再报错。
 * 修复：编译器自己插入 super 状态机（调用计数 + this 守卫），代价是每个 this 访问都要包一层。
 */
async function case07_superConstraints() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  class NoSuper extends A {
    // @ts-expect-error
    async constructor() {
      sideEffect('forgot await super()'); // 原生：ReferenceError；降级后：A 的构造体从没执行，实例却可用
    }
  }
  class Twice extends A {
    // @ts-expect-error
    async constructor(again: boolean) {
      // @ts-expect-error
      await super();
      // @ts-expect-error
      if (again) await super(); // 原生：ReferenceError；降级后：A 的构造体执行第二遍
    }
  }
  await new NoSuper();
  await new Twice(true);
}

/**
 * case08 【无解】编译期不知道继承链上有没有 async 构造函数
 *
 * 降级子类需要知道：父类有没有 constructParent、它叫什么、从哪里 import，以及中间层有没有被改写：
 *   - 继承链跨文件时（tsconfig 里 isolatedModules: true）单文件转译拿不到父类信息
 *   - 父类来自 .d.ts / 没经过本编译器的 npm 包：它的 async constructor 要么没降级（无法使用），
 *     要么降级了但 constructA 没导出
 *   - mixin：`const M = (Base) => class extends Base { constructor(...a){ super(...a); this.m = 1 } }`，
 *     Base 是参数，编译期完全不可知；这个同步中间层会被 super() 抛出的 raw 打断（case01 的问题）
 *   - `class X extends (cond ? A : B)`、`extends mixin(A)` 这类表达式
 * 运行期探测（给每个降级类挂一个 Symbol.for 标记 + 暴露 constructX）能缓解“父类是不是 async”，
 * 但解决不了“夹在中间的同步类被 throw 打断”，这一点只能靠整条链都被本编译器改写。
 */
async function case08_unknownChain() {
  const Mixin = <T extends new (...args: any[]) => object>(Base: T) =>
    class extends Base {
      mixed = true; // 降级后丢失
      constructor(...args: any[]) {
        super(...args);
        sideEffect('mixin'); // 降级后不会执行
      }
    };
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  class C extends Mixin(A) {}
  await new C();
}

/**
 * case09 【无解】装饰器 / Proxy / 包装类
 *
 * 类装饰器、`Proxy(class, { construct })`、`class extends Base` 的代理子类，
 * 通常会返回/创建一个包装类，里面执行 `new target(...args)` 或 `super(...args)` 并加上自己的逻辑。
 * 这些包装代码不知道 async constructor 的存在：
 *   - 装饰器写在库里，无法被本编译器改写
 *   - 包装类的同步构造函数会被 super() 抛出的 raw 打断（case01）
 *   - 即使装饰器是用户自己的，返回的新类不再有 async 标记，调用点无从得知（case13）
 */
async function case09_decorators() {
  function logged<T extends new (...args: any[]) => object>(Base: T) {
    return class extends Base {
      constructor(...args: any[]) {
        super(...args);
        sideEffect('constructed'); // 降级后：永远不执行
      }
    };
  }
  const A = logged(
    class {
      // @ts-expect-error
      async constructor() {
        // @ts-expect-error
        await fetchJson('/a');
      }
    },
  );
  await new A();
}

/* ========================================================================== *
 * B. 调用点
 * ========================================================================== */

/**
 * case10 【无解】调用点所在的语法位置不能 await
 *
 * 方案第 3 步需要在调用处写 `b = await e`，但下面这些位置不允许 await，
 * 而且也不能像普通函数那样“顺手改成 async”，因为会改变它们的签名 / 调用约定：
 *   - getter / setter、Symbol.iterator、toString / valueOf / toJSON 等被引擎隐式调用的方法
 *   - 类实例字段初始化器、static 块（static 块里禁止 await）
 *   - 同步 constructor（要把它也变成 async constructor，就是传染，见 case01）
 *   - 参数默认值（所在函数不是 async 时）
 *   - sort 比较函数、Proxy trap 等同步回调
 */
async function case10_syncContexts() {
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

/**
 * case11 【方案缺陷】new A() 出现在表达式中间：求值顺序、短路、链式调用
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
async function case11_expressionPosition(cond: boolean, f: (...a: any[]) => any) {
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

/**
 * case12 【语义偏差】不 await 的 new：并发 / 保存 promise / 竞速
 *
 * 原生提案里 `new A()` 的值就是 Promise<A>，所以下面这些都是合法且有意义的写法。
 * 但 class.ts 的调用点模板固定写 `b = await e`，等于把每个 `new A()` 都强制变成“立即 await”：
 *   - Promise.all([new A(), new B()]) 从并发变成串行
 *   - const p = new A(); doOther(); await p;  顺序被打乱，doOther 被推迟到 A 构造完成之后
 *   - new A();  fire-and-forget，会被迫等待
 *   - Promise.race / allSettled / .then / .catch 链
 * 修复思路：catch 里直接返回 e（promise）而不是 await e，让 `new A()` 降级成“值是 promise 的表达式”，
 * 这样 await 由用户自己写的 await 负责，也顺带消除 case10 中大部分“不能 await”的问题。
 * 但那样 class.ts 里的 `b = await e` 这一步就需要重写，整个模板的语义都要改。
 */
async function case12_concurrency() {
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

/**
 * case13 【无解】编译期无法确定“这个 new 是不是 async 构造”
 *
 * 降级需要在每个 `new X()` 处插入 try/catch，但并不是所有调用点都能被识别：
 *   - 单文件转译（isolatedModules）：import 进来的类是否 async 看不到
 *   - 泛型 / 构造签名：function make<T>(C: new () => T) { return new C() }
 *   - 动态：new (await import('./x')).default()、new this.constructor()、Reflect.construct()
 *   - 第三方库 / 框架代码：DI 容器、ORM、序列化库、React 等内部的 new —— 它们不会经过本编译器
 *   - Proxy 的 construct 转发
 * 这些位置会直接收到一个被抛出的 promise，表现为一个莫名其妙的异常（并伴随 case24 的未处理 rejection）。
 *
 * 退而求其次是“所有 new 都包 try/catch”，代价：
 *   - 全部代码都要被改写、并且体积和性能受影响（case25）
 *   - class.ts 的模板在 new 正常返回（类不是 async）时 b 永远不会被赋值，
 *     必须写成 try { b = new X() } catch (e) { if (has(e)) b = await e; else throw e }
 *   - 非 async 类的 new 也被改写成 await 之后，结果类型会从 T 变成 Promise<T> 还是 T？
 *     两种返回形态混在同一个表达式里，调用方无法静态区分
 */
async function case13_unknownCallSite<T>(C: new () => T, Dyn: any) {
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

/**
 * case14 【无解】用户自己的 try/catch / Promise 执行器会吞掉被抛出的 promise
 *
 * 构造函数用 throw 传递 promise，用户代码里任何“泛捕获”都会截获它：
 *   - 外层 catch 以为是普通错误，打印 / 吞掉 / 转换成别的错误
 *   - new Promise(() => { new A() }) 的执行器：promise 被当成 rejection reason
 *   - catch (e) { if (e instanceof MyError) ... else throw e } 虽然会重新抛出，但中间的 finally 会提前执行
 *   - 同步包装类里 `try { super() } catch {}`（case01 / case09 的同步中间层）会把整个初始化吞掉
 *     （async 子类里的 `await super()` 在降级后是普通的 await constructParent，用户 try/catch 能正常工作）
 * 即使调用点被编译器改写，用户写的 catch 子句也要被一并改写，否则：
 *   try { new A() } catch (e) { log(e) }   // e 其实是内部 promise，且原本就不应该进入这里
 */
async function case14_userCatchSwallows() {
  class A {
    // @ts-expect-error
    async constructor() {
      throw new Error('init failed');
    }
  }
  try {
    await new A();
  } catch (e) {
    // 原生语义：这里收到 Error('init failed')
    // 降级后：编译器必须确保这里依然收到 Error 而不是内部 promise
  }
  new Promise(() => {
    new A(); // 执行器里的 new 同理：reject 的原因是 promise，而不是 Error
  });
}

/**
 * case15 【无解】类型系统：new A() 的类型是 A，而不是 Promise<A>
 *
 * 降级只发生在 JS 输出阶段，类型检查仍然把 `new A()` 当作 A：
 *   - InstanceType<typeof A>、ConstructorParameters 等工具类型
 *   - 构造签名 `new () => T` 的结果是 T，但实际应该是 Promise<T>；
 *     因此需要一套新的 `async new () => T` 签名，并改写所有现有的泛型工具
 *   - .d.ts 输出：declaration: true 时需要把 async constructor 表达出来
 *   - class 实现 interface 时，构造签名无法参与 implements 检查
 *   - 子类 extends 一个 async 父类时，TS 对 `super()` 返回值的类型推导也需要配套
 * 这些都不是降级编译方案能解决的，需要类型系统一起配套修改。
 */
async function case15_types() {
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

/* ========================================================================== *
 * C. 构造函数体提取
 * ========================================================================== */

/**
 * case16 【方案缺陷】#私有成员 / private / protected 无法在类外访问；以及它与继承的冲突
 *
 * class.ts 把函数体提取成类外的 `async function constructA(this: any, ...)`：
 *   - this.#count 在类外是 SyntaxError（私有名只能写在 class 体内）
 *   - `#x in this` 品牌检查、A.#staticCounter 同理
 *   - TS 的 private / protected 在类外访问会报错，只能靠 this: any 绕开，失去类型检查
 * 修复：不提取成顶层函数，而是提取成类内的 `static async #construct(this: A, ...)` 或私有方法。
 * 但这和继承冲突：
 *   - 子类的 constructSub 要调用父类的 constructParent，而父类的 #construct 对子类不可见，
 *     必须再暴露一个非私有的入口（如 static [Symbol.for('construct')]），可见性被迫放宽
 *   - 类内方法的 super.xxx 可以保留（case06 的好处），但 class 的“形状”在 devtools / 反射里会多出成员
 */
async function case16_privateAccess() {
  class A {
    #count = 0;
    static #instances = 0;
    private secret = 's';
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      this.#count = (await fetchJson('/count')).n;
      A.#instances++;
      if (#count in this) sideEffect(this.secret);
    }
  }
  await new A();
}

/**
 * case17 【方案缺陷】new.target
 *
 * 提取出的函数是用 `.call(this, args)` 调用的，new.target 在其中恒为 undefined。
 * 抽象类 / 工厂常见写法 `if (new.target === Base) throw ...`、`Object.create(new.target.prototype)` 会失效。
 * 修复：编译器需把 new.target 当作隐藏参数传入（constructA.call(this, new.target, ...args)），
 * 而且在继承链上每一层 constructSub -> constructParent 都要原样转发，
 * 隐式构造函数（`class Impl extends Base {}`，case01）也要合成这个转发。
 */
async function case17_newTarget() {
  class Base {
    kind: any;
    // @ts-expect-error
    async constructor() {
      if (new.target === Base) throw new Error('abstract');
      this.kind = new.target.name;
      // @ts-expect-error
      await fetchJson('/k');
    }
  }
  class Impl extends Base {}
  await new Impl();
}

/**
 * case18 【方案缺陷】参数处理：arguments、默认值、解构、rest、参数属性
 *
 *   - 函数体里用 arguments：提取后 arguments 变成 constructA 自己的，必须原样转发 `...arguments`
 *   - 参数默认值引用前面的参数、this 或类私有名：
 *       默认值的求值时机、作用域和异常类型（同步抛出 vs 变成 rejection）都会变化
 *       例：constructor(a, b = a.length) 里 a 为 undefined，原生是 async 函数式的 rejection，
 *       降级后如果 constructor 保留了原参数列表，则是同步 TypeError；二者必须选一个并保持一致
 *   - TS 参数属性 `async constructor(private x: number)`：赋值语句由 TS 在函数体头部生成，
 *     提取顺序不对会导致 constructA 里访问不到 this.x
 *   - constructor.length（形参个数）和 fn.toString() 会变
 *   - 子类 `await super(args)` 的参数表达式如果自己含有 await：它在 super 调用之前求值，
 *     降级成 constructParent.call(this, ...) 后顺序可以保持，但保留 extends 的方案（case02）里
 *     就变成“super() 的参数里有 await”，原生 JS 的 derived constructor 做不到
 * class.ts 示例只演示了单个简单参数 `args`。
 */
async function case18_parameters() {
  class A {
    // @ts-expect-error
    async constructor(private id: number, opts: { retry?: number } = {}, ...rest: any[]) {
      // @ts-expect-error
      await fetchJson('/a/' + this.id + '/' + (opts.retry ?? 0) + arguments.length);
    }
  }
  await new A(1);
}

/**
 * case19 【方案缺陷】构造函数里 return（含父类 return 对子类 this 的影响）
 *
 * 普通 constructor 可以 `return otherObject` 覆盖 new 的结果（单例、缓存、代理包装）。
 * class.ts 的 `.then(() => this)` 直接丢弃了 constructA 的返回值（已验证：return override kept? false），
 * 所以 `return cache.get(key)` 之类的写法会静默失效，拿到的是新建的 this。
 *
 * 子类场景更严重：原生里父类 return 的对象会成为子类 super() 之后的 this（已验证 new CC() === other），
 * 子类后面的 `this.y = 1` 写在这个对象上。降级后 constructSub 里 `await constructA.call(this)` 的返回值被丢弃，
 * 子类继续往原来的 this 上写，父类返回的对象被完全忽略。
 * 修复：`.then((r) => (typeof r === 'object' && r !== null) || typeof r === 'function' ? r : this)`，
 * 且 constructSub 必须把 `const self = await constructParent.call(this, ...)` 之后的 this 全部改写成 self，
 * 还要保证 await 之前和之后的 return 语义一致（提案本身对此需要给出规定）。
 */
async function case19_returnOverride() {
  const cache = new Map<string, any>();
  class A {
    // @ts-expect-error
    async constructor(key: string) {
      const hit = cache.get(key);
      if (hit) return hit; // 期望：返回缓存实例
      // @ts-expect-error
      await fetchJson('/a');
      cache.set(key, this);
    }
  }
  const a1 = await new A('k');
  const a2 = await new A('k');
  return a1 === a2; // 降级后为 false
}

/**
 * case20 【方案缺陷】提取到模块顶层会丢失闭包 / 命名冲突 / 跨模块可见性
 *
 *   - 类定义在函数、块、类工厂里：构造函数体引用了局部变量（如下面的 token），
 *     提取到文件顶层后这些变量不在作用域内。提取位置必须与类声明处于同一作用域。
 *   - 匿名类表达式 / export default class {}：没有名字可以派生 constructX
 *   - 同一作用域下多个类、同名类（不同块里的 class A）：提取出的函数名需要唯一，
 *     且不能与用户代码冲突（需要统一的命名规则，例如带唯一后缀）
 *   - 类表达式在循环 / 工厂函数里每次创建新的类：提取函数需要每次也重新创建，不能放到顶层复用
 *   - 子类要 import 父类的 constructA：constructA 必须从模块导出，会污染模块的公开导出表、
 *     影响 tree-shaking，并且 .d.ts 也要声明它
 */
function case20_closureScope(token: string) {
  const Factory = () =>
    class {
      // @ts-expect-error
      async constructor() {
        // @ts-expect-error
        await fetchJson('/a?token=' + token); // token 来自外层函数
      }
    };
  return [Factory(), Factory()];
}

/**
 * case21 【方案缺陷】TS 严格检查：属性初始化 / readonly
 *
 * 提取后构造函数里没有对属性赋值了，tsconfig 里开了 strict：
 *   - strictPropertyInitialization：`data: Foo` 提示“没有初始化表达式，且未在构造函数中明确赋值” (TS2564)
 *     需要编译器自动补 `!`，或类型检查要在降级之前做（用原始 AST 检查）
 *   - readonly 字段只能在 constructor 里赋值；提取到类外的函数后赋值被判为非法 (TS2540)
 *   - exactOptionalPropertyTypes 同理，赋值的位置变了，窄化信息消失
 * 如果 constructA 声明为 `this: any` 则这些检查全部被绕过（class.ts 就是这么做的），类型安全丢失。
 */
async function case21_strictChecks() {
  class A {
    readonly id: number;
    data: string;
    // @ts-expect-error
    async constructor() {
      this.id = 1;
      // @ts-expect-error
      this.data = await fetchJson('/a');
    }
  }
  await new A();
}

/* ========================================================================== *
 * D. 降级产物的运行时行为
 * ========================================================================== */

/**
 * case22 【无解】实例本身是 thenable（已验证）
 *
 * 降级用 `raw = constructA.call(this).then(() => this)`：promise 以 this 作为解析值，
 * 如果 this 有 then 方法（自定义 then、或 class extends Promise / 继承了带 then 的基类），
 * Promise 解析过程会把它当作 thenable 去调用 this.then(...)。
 * 实测：`class T { then(r) { r('hijacked') } }` 被 resolve 之后，await 得到的是 'hijacked' 而不是实例；
 * then 里又返回 this 则会无限递归或永久 pending。
 * 原生提案要先规定“thenable 实例如何处理”，而降级方案没有任何办法绕开 Promise 的解析规则
 * （把 this 包装一层 { value: this } 再拆开的话，又需要调用方一起配合，破坏 await new A() 的语义）。
 * 继承时更容易踩：父类带 then 的话，所有子类实例都是 thenable。
 */
async function case22_thenableInstance() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
    then(resolve: (v: any) => void) {
      resolve('hijacked');
    }
  }
  const a = await new A(); // 降级后：a === 'hijacked'，而不是 A 的实例
  return a;
}

/**
 * case23 【方案缺陷】globalContainer 的身份一致性
 *
 * 判断“这是不是 async 构造抛出的 promise”靠的是一个 WeakSet 里的引用。
 *   - 同一份运行时被打包两次（monorepo 中多份依赖、微前端、HMR 重载），每份都有自己的 globalContainer，
 *     A 在模块实例 1 里 throw，调用点在模块实例 2 里 has() 返回 false，被当作普通异常重新抛出
 *   - iframe / worker / vm 多个 realm 之间同理
 *   - 反过来，用户代码主动 throw 了一个恰好被放进 container 的 promise 引用也会被误吞
 * 修复：用全局注册表（Symbol.for + globalThis）而不是模块级变量，
 * 或者抛出一个带特殊 Symbol.for 标记的专用对象，而不是裸 promise。
 */
async function case23_containerIdentity() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  await new A(); // 如果 A 与调用点来自两份 runtime，就会抛出 Promise 对象
}

/**
 * case24 【语义偏差】错误与栈信息、未处理的 rejection
 *
 *   - 被抛出的 promise 如果 rejected，而没有被调用点 await/catch（case13、case14 的任何一种泄漏），
 *     就会触发 unhandledrejection，错误和构造位置的关联完全丢失
 *   - 构造函数里同步 throw 的 Error：原生 async constructor 语义是转成 rejection，
 *     降级后确实也是 rejection，但调用栈里不再包含 `new A()` 所在的同步栈帧（只有 await 之后的异步栈）
 *   - `await e` 的 rejection 是从调用点重新抛出的，但 Error.stack 依旧指向 constructA 内部，
 *     source map 要特殊处理才能让栈回到用户的 constructor
 *   - 继承链越深（constructSub -> constructParent -> ...），异步栈越长，且全是提取出来的函数名
 */
async function case24_errorsAndStacks() {
  class A {
    // @ts-expect-error
    async constructor() {
      throw new Error('boom');
    }
  }
  new A(); // fire-and-forget：降级后 raw 被抛出并泄漏，同时触发 unhandledrejection
}

/**
 * case25 【语义偏差】性能与调试体验
 *
 *   - 每一次构造都要经历一次 throw / catch：V8 对 throw 有明显开销，会阻碍某些优化（内联、逃逸分析）；
 *     构造函数是热路径时尤其明显
 *   - 调试器开启“Pause on caught exceptions”后，每次 new A() 都会中断一次
 *   - 对每个调用点都包 try/catch（case13 的兜底方案）会让所有 new 表达式的代码体积膨胀
 *   - WeakSet.add 对每个实例多一次分配；case03 的 setPrototypeOf 还会让原型链变成慢路径
 *   - 与 async 函数不同，抛出方式让引擎无法把 `new A()` 识别成“返回 promise 的调用”，
 *     所有基于调用约定的静态分析 / 优化（devtools async stack trace、lint 的 no-floating-promises）全部失效
 */
async function case25_performanceAndDebugging() {
  class A {
    // @ts-expect-error
    async constructor() {
      // @ts-expect-error
      await fetchJson('/a');
    }
  }
  for (let i = 0; i < 1e6; i++) {
    await new A(); // 每次迭代一次 throw + catch
  }
}
