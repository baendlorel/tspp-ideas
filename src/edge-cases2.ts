/**
 * async constructor 降级方案（class.ts）无法囊括的边界情况 —— 不含继承的版本
 * 提案写法见 normal.ts，降级结果见 class.ts；完整版（含继承）见 edge-cases.ts
 *
 * 本文件的前提：假设类之间没有 extends（或者提案直接禁止 async 类参与继承），
 * 因此 edge-cases.ts 里 case01 ~ case09（同步子类、父类字段/#私有成员丢失、原型链、字段顺序、
 * 同步父类、super.xxx、super 约束、未知继承链、装饰器/包装类）整组删除，
 * 其余 case 里只和继承有关的段落也已删掉（new.target 的抽象类用法、constructParent 导出等）。
 *
 * 评估基准（class.ts 中不含继承的部分）
 *   1. 构造函数体提取成类外的 `async function constructX(this: any, args)`
 *   2. 原 constructor 只做 `throw raw`（raw = constructX.call(this).then(() => this)），raw 登记在 globalContainer
 *   3. 调用点 try { new X() } catch (e) { if (globalContainer.has(e)) b = await e; else throw e }
 *
 * 标记说明
 *   【无解】     在“构造函数抛出 promise”这一机制下，语义上无法等价降级
 *   【方案缺陷】 class.ts 中描述的方案没有覆盖，但可通过扩展编译规则修复（case 里会写修复思路和代价）
 *   【语义偏差】 能编译通过，但行为与原生 async constructor 提案不一致
 *   （标注“已验证”的结论用 node 实测过，其余是根据语言规范推断）
 *
 * 去掉继承之后的结果：共 16 个 case
 *   【无解】 5 个：case01、case04、case05、case06、case13
 *   【方案缺陷】 8 个：case02、case07 ~ case12、case14
 *   【语义偏差】 3 个：case03、case15、case16
 * 剩下的“无解”全部出在调用点（new 出现在哪里、谁来 catch）、类型系统，以及 thenable 实例这条 Promise 规则上，
 * 构造函数体本身（提取、参数、this、return）没有无解项，都可以靠扩展编译规则修好。
 * 也就是说：去掉继承能消除“构造过程”侧的大部分硬伤，但“throw promise”这个传递机制带来的调用点问题原封不动。
 *
 * 每个 case 先用提案语法写出原始代码（// @ts-expect-error 是因为 TS 不认识 async constructor），
 * 再在注释里说明降级后会发生什么。本文件只做记录，不会被执行。
 *
 * 目录
 *   A. 调用点（new A() 所在位置）    case01 ~ case06
 *   B. 构造函数体提取                case07 ~ case12
 *   C. 降级产物的运行时行为          case13 ~ case16
 */

declare function fetchJson(url: string): Promise<any>;
declare function sideEffect(tag: string): any;

/* ========================================================================== *
 * A. 调用点
 * ========================================================================== */


/**
 * case05 【无解】用户自己的 try/catch / Promise 执行器会吞掉被抛出的 promise
 *
 * 构造函数用 throw 传递 promise，用户代码里任何“泛捕获”都会截获它：
 *   - 外层 catch 以为是普通错误，打印 / 吞掉 / 转换成别的错误
 *   - new Promise(() => { new A() }) 的执行器：promise 被当成 rejection reason
 *   - catch (e) { if (e instanceof MyError) ... else throw e } 虽然会重新抛出，但中间的 finally 会提前执行
 * 即使调用点被编译器改写，用户写的 catch 子句也要被一并改写，否则：
 *   try { new A() } catch (e) { log(e) }   // e 其实是内部 promise，且原本就不应该进入这里
 */
async function case05_userCatchSwallows() {
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

// ?? 这是不可能的，因为它只捕获在weakset里的promise，其他的都放行。用户自己没有任何办法可以捕捉到我们添加的throw。因为位置决定了这件事


/* ========================================================================== *
 * B. 构造函数体提取
 * ========================================================================== */

/**
 * case07 【方案缺陷】#私有成员 / private / protected 无法在类外访问
 *
 * class.ts 把函数体提取成类外的 `async function constructA(this: any, ...)`：
 *   - this.#count 在类外是 SyntaxError（私有名只能写在 class 体内）
 *   - `#x in this` 品牌检查、A.#staticCounter 同理
 *   - TS 的 private / protected 在类外访问会报错，只能靠 this: any 绕开，失去类型检查
 * 修复：不提取成顶层函数，而是提取成类内的 `static async #construct(this: A, ...)` 或私有方法 `async #construct(...)`，
 * 然后在 constructor 里调用。私有方法在字段初始化之前就已安装，所以可行。
 * 没有继承时这个修复没有后顾之忧（有继承时子类调不到父类的私有 #construct，见 edge-cases.ts 的 case16）。
 * 剩下的代价只有：class 的“形状”在 devtools / 反射里会多出一个成员。
 */
async function case07_privateAccess() {
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
 * case08 【方案缺陷】new.target
 *
 * 提取出的函数是用 `.call(this, args)` 调用的，new.target 在其中恒为 undefined。
 * 没有继承时，new.target 几乎总等于类本身，只剩下两种用法：
 *   - 防御性写法 `if (!new.target) throw ...`（对 async constructor 本来就不会发生）
 *   - `Reflect.construct(A, args, Other)`：显式指定 newTarget，实例的原型是 Other.prototype，
 *     new.target.prototype / new.target.name 在 async 体里应该是 Other 的
 * 修复：编译器把 new.target 当作隐藏参数传入（constructA.call(this, new.target, ...args)），
 * 并把函数体里所有 new.target 改写成该参数。同样，箭头函数里的 new.target 也要跟着改写。
 * 与 edge-cases.ts 的 case17 相比，抽象类（`new.target === Base`）这一最常见用法依赖继承，已不在讨论范围内。
 */
async function case08_newTarget() {
  class A {
    kind: any;
    // @ts-expect-error
    async constructor() {
      this.kind = new.target.name; // 提取后：TypeError: Cannot read properties of undefined (reading 'name')
      // @ts-expect-error
      await fetchJson('/k');
    }
  }
  class Other {}
  await Reflect.construct(A, [], Other);
}
// ?? 依然可以靠词法分析勉强完成

/**
 * case09 【方案缺陷】参数处理：arguments、默认值、解构、rest、参数属性
 *
 *   - 函数体里用 arguments：提取后 arguments 变成 constructA 自己的，必须原样转发 `...arguments`
 *   - 参数默认值引用前面的参数、this 或类私有名：
 *       默认值的求值时机、作用域和异常类型（同步抛出 vs 变成 rejection）都会变化
 *       例：constructor(a, b = a.length) 里 a 为 undefined，原生是 async 函数式的 rejection，
 *       降级后如果 constructor 保留了原参数列表，则是同步 TypeError；二者必须选一个并保持一致
 *   - TS 参数属性 `async constructor(private x: number)`：赋值语句由 TS 在函数体头部生成，
 *     提取顺序不对会导致 constructA 里访问不到 this.x
 *   - constructor.length（形参个数）和 fn.toString() 会变
 * class.ts 示例只演示了单个简单参数 `args`。
 */
async function case09_parameters() {
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
 * case10 【方案缺陷】构造函数里 return
 *
 * 普通 constructor 可以 `return otherObject` 覆盖 new 的结果（单例、缓存、代理包装）。
 * class.ts 的 `.then(() => this)` 直接丢弃了 constructA 的返回值（已验证：return override kept? false），
 * 所以 `return cache.get(key)` 之类的写法会静默失效，拿到的是新建的 this。
 * 修复：`.then((r) => (typeof r === 'object' && r !== null) || typeof r === 'function' ? r : this)`，
 * 还要保证 await 之前和之后的 return 语义一致（提案本身对此需要给出规定）。
 * 另外，async 体里 `return 1`（原始值）原生 constructor 会被忽略、返回 this，修复里的 typeof 判断正是为此。
 */
async function case10_returnOverride() {
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
 * case11 【方案缺陷】提取到模块顶层会丢失闭包 / 命名冲突
 *
 *   - 类定义在函数、块、类工厂里：构造函数体引用了局部变量（如下面的 token），
 *     提取到文件顶层后这些变量不在作用域内。提取位置必须与类声明处于同一作用域。
 *   - 匿名类表达式 / export default class {}：没有名字可以派生 constructX
 *   - 同一作用域下多个类、同名类（不同块里的 class A）：提取出的函数名需要唯一，
 *     且不能与用户代码冲突（需要统一的命名规则，例如带唯一后缀）
 *   - 类表达式在循环 / 工厂函数里每次创建新的类：提取函数需要每次也重新创建，不能放到顶层复用
 * 没有继承时 constructX 不必导出，不会污染模块导出表；如果采用 case07 的修复（提取成类内私有方法），
 * 闭包和命名这几条也一并消失，因为提取出来的东西就在类体里。
 */
function case11_closureScope(token: string) {
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
 * case12 【方案缺陷】TS 严格检查：属性初始化 / readonly
 *
 * 提取后构造函数里没有对属性赋值了，tsconfig 里开了 strict：
 *   - strictPropertyInitialization：`data: Foo` 提示“没有初始化表达式，且未在构造函数中明确赋值” (TS2564)
 *     需要编译器自动补 `!`，或类型检查要在降级之前做（用原始 AST 检查）
 *   - readonly 字段只能在 constructor 里赋值；提取到类外的函数后赋值被判为非法 (TS2540)
 *   - exactOptionalPropertyTypes 同理，赋值的位置变了，窄化信息消失
 * 如果 constructA 声明为 `this: any` 则这些检查全部被绕过（class.ts 就是这么做的），类型安全丢失。
 */
async function case12_strictChecks() {
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
 * C. 降级产物的运行时行为
 * ========================================================================== */

/**
 * case13 【无解】实例本身是 thenable（已验证）
 *
 * 降级用 `raw = constructA.call(this).then(() => this)`：promise 以 this 作为解析值，
 * 如果 this 有 then 方法，Promise 解析过程会把它当作 thenable 去调用 this.then(...)。
 * 实测：`class T { then(r) { r('hijacked') } }` 被 resolve 之后，await 得到的是 'hijacked' 而不是实例；
 * then 里又返回 this 则会无限递归或永久 pending。
 * 原生提案要先规定“thenable 实例如何处理”，而降级方案没有任何办法绕开 Promise 的解析规则
 * （把 this 包装一层 { value: this } 再拆开的话，又需要调用方一起配合，破坏 await new A() 的语义）。
 * 不继承时只有类自己显式写了 then 才会触发，概率比继承场景低，但仍然无法消除。
 */
async function case13_thenableInstance() {
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
 * case14 【方案缺陷】globalContainer 的身份一致性
 *
 * 判断“这是不是 async 构造抛出的 promise”靠的是一个 WeakSet 里的引用。
 *   - 同一份运行时被打包两次（monorepo 中多份依赖、微前端、HMR 重载），每份都有自己的 globalContainer，
 *     A 在模块实例 1 里 throw，调用点在模块实例 2 里 has() 返回 false，被当作普通异常重新抛出
 *   - iframe / worker / vm 多个 realm 之间同理
 *   - 反过来，用户代码主动 throw 了一个恰好被放进 container 的 promise 引用也会被误吞
 * 修复：用全局注册表（Symbol.for + globalThis）而不是模块级变量，
 * 或者抛出一个带特殊 Symbol.for 标记的专用对象，而不是裸 promise。
 */
async function case14_containerIdentity() {
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
 * case15 【语义偏差】错误与栈信息、未处理的 rejection
 *
 *   - 被抛出的 promise 如果 rejected，而没有被调用点 await/catch（case04、case05 的任何一种泄漏），
 *     就会触发 unhandledrejection，错误和构造位置的关联完全丢失
 *   - 构造函数里同步 throw 的 Error：原生 async constructor 语义是转成 rejection，
 *     降级后确实也是 rejection，但调用栈里不再包含 `new A()` 所在的同步栈帧（只有 await 之后的异步栈）
 *   - `await e` 的 rejection 是从调用点重新抛出的，但 Error.stack 依旧指向 constructA 内部，
 *     source map 要特殊处理才能让栈回到用户的 constructor
 */
async function case15_errorsAndStacks() {
  class A {
    // @ts-expect-error
    async constructor() {
      throw new Error('boom');
    }
  }
  new A(); // fire-and-forget：降级后 raw 被抛出并泄漏，同时触发 unhandledrejection
}

/**
 * case16 【语义偏差】性能与调试体验
 *
 *   - 每一次构造都要经历一次 throw / catch：V8 对 throw 有明显开销，会阻碍某些优化（内联、逃逸分析）；
 *     构造函数是热路径时尤其明显
 *   - 调试器开启“Pause on caught exceptions”后，每次 new A() 都会中断一次
 *   - 对每个调用点都包 try/catch（case04 的兜底方案）会让所有 new 表达式的代码体积膨胀
 *   - WeakSet.add 对每个实例多一次分配
 *   - 与 async 函数不同，抛出方式让引擎无法把 `new A()` 识别成“返回 promise 的调用”，
 *     所有基于调用约定的静态分析 / 优化（devtools async stack trace、lint 的 no-floating-promises）全部失效
 */
async function case16_performanceAndDebugging() {
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
