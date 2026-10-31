/**
 * async constructor 降级方案 SubInit 法（plan/subinit.ts）的边界情况
 * 提案写法见 plan/normal.ts，降级结果见 plan/subinit.ts
 *
 * 评估基准（SubInit 当前方案）
 *   1. 模块级 hiddenSym / callSym 两个 symbol
 *   2. 原 constructor 体搬进 `async [hiddenSym](key, args)`，真正的 constructor 只保留 `super(args)`
 *   3. 子类 `await super(args)` 改写成 `await super[hiddenSym](key, args)`
 *   4. 调用点 `await new A(args)` 改写成 `await createInstance(A, args)`
 *
 * 标记说明（与 1.ts 一致）
 *   【无解】     在 SubInit 机制下，语义上无法等价降级
 *   【方案缺陷】 plan/subinit.ts 没有覆盖，但可通过扩展编译规则修复（case 里写修复思路和代价）
 *   【语义偏差】 能编译通过，但行为与原生 async constructor 提案不一致
 *   （标注“已验证”的结论用 node 实测过，其余是根据语言规范推断）
 *
 * 与 1.ts（throw 方案）的差别：SubInit 保留了 extends / 原型链 / #私有字段 / super.method / instanceof，
 * 所以 1.ts 的 case02、03、06、16、22 在这里基本不存在。本文件只记录 SubInit 自己的问题，
 * 以及“与降级机制无关、两种方案都有”的调用点问题（只做索引，不重复展开）。
 *
 * 本文件只做记录，不会被执行。
 *
 * 目录
 *   A. 初始化顺序与语义偏差   case01 ~ case05
 *   B. 调用验证与误用         case06 ~ case09
 *   C. 继承                   case10 ~ case13
 *   D. 构造函数体语义         case14 ~ case17
 *   E. 调用点（与 1.ts 共通） case18
 *   F. symbol 的工程问题      case19 ~ case21
 *   G. 其他                   case22 ~ case24
 */

const hiddenSym = Symbol();
const callSym = Symbol();

async function createInstance(cls: any, ...args: any[]) {
  const inst = new cls(...args);
  await inst[hiddenSym](callSym, ...args);
  return inst;
}

declare function load(): Promise<any>;
declare function sideEffect(tag: string): any;

/* ========================================================================== *
 * A. 初始化顺序与语义偏差
 * ========================================================================== */

/**
 * case01 ✅ 【语义偏差】子类字段初始化早于父类的 async 部分（已验证）
 *
 * 原生语义：`await super()` 返回之后，子类字段才初始化。即顺序为
 *   父类字段 -> 父类 async 体 -> 子类字段 -> 子类 async 体余下部分
 * SubInit：真正的 constructor 是同步链，`new cls()` 一返回，所有类的字段都已经初始化完，
 * 之后才进 [hiddenSym] 链。顺序变成
 *   父类字段 -> 子类字段 -> 父类 async 体 -> 子类 async 体余下部分
 *
 * 可观察的后果：
 *   - 子类重新声明了父类 async 体里会赋值的字段：实测 x = 'parent-init'，原生应为 'sub-field'
 *   - 父类 async 体里调用被子类覆写的方法，方法里读到的子类字段已经有值，原生语义下还是 undefined
 *   - 子类字段初始化器里的副作用 / 对 this 的读取，发生在父类 async 体之前
 *
 * 修复思路：把子类的字段初始化器也搬进 [hiddenSym]，放在 `await super[hiddenSym]()` 之后。
 * 代价：#私有字段的声明必须保留在类体里（只能搬初始化），字段声明与赋值被拆开；
 *       `useDefineForClassFields` 语义（define 而非 set）需要用 Object.defineProperty 重写；
 *       字段 key 是计算属性时，求值时机又变了（类定义时 vs 实例化时）。
 */
async function case01_fieldOrder() {
  class A {
    x: any;
    // @ts-expect-error
    async constructor() {
      await 0;
      this.x = 'parent-init';
    }
  }
  class B extends A {
    x = 'sub-field'; // 原生：super 返回后才安装，最终 'sub-field'
  }
  const b = await new B();
  void b;
}
// # 可以接受
// ✅ 已接受：这是 SubInit 已知的顺序偏差（子类字段先于父类 async 体安装），不修复，只在文档里标明。

/**
 * case02 ✅ 【语义偏差】同步子类（含隐式构造函数）的构造函数体先于父类 async 初始化执行（已验证）
 *
 * 显式同步构造函数 `constructor() { super(); log('F') }` 的函数体留在真正的 constructor 里，
 * 实测顺序 `F sync body -> E init`。原生语义下，同步子类调用 `super()` 得到的是 Promise，
 * 提案本身要先规定它是编译错误，还是自动“传染”成 async（见 1.ts case01）。
 *
 * 选“传染”：编译器把子类合成为 `async constructor() { await super(); ...原函数体 }`，
 * 函数体搬进 [hiddenSym]。比 throw 方案容易实现，因为隐式构造函数 `class C extends A {}`
 * 本来就继承了 [hiddenSym]，不需要合成任何东西。
 * 代价：C 的对外契约从同步变成异步，所有 `new C()` 都要改写（case18）；
 *       C 在另一个没被本编译器处理的包里时传染不到。
 */
async function case02_syncSubclass() {
  class E {
    // @ts-expect-error
    async constructor() {
      await 0;
      sideEffect('E init');
    }
  }
  class F extends E {
    constructor() {
      // @ts-expect-error
      super();
      sideEffect('F sync body');
    }
  }
  void F;
}
// # 这不是很正常吗
// ✅ 你说得对，不是偏差：原生语义下同步子类的 `super()` 不 await，函数体同样先于父类 async 体执行，
//    顺序 `F sync body -> E init` 与原生一致。剩下的只是提案层面“同步子类要不要报错”，与降级方案无关。


/**
 * case03 ✅ 【语义偏差】参数被求值两次（已验证）
 *
 * `constructor(args)` 与 `[hiddenSym](key, args)` 各自带一份形参列表。
 * 默认值、解构、getter、`arguments` 访问里的副作用会执行两次（实测 `++calls` 跑了 2 次）。
 *
 * 修复思路：真正的 constructor 不声明形参（用 `constructor(...) {}` 空 rest 或干脆不写），
 * 参数只在 [hiddenSym] 里解析一次。
 * 代价：子类的 `super(args)` 参数列表对于“同步父类 / 内建类”是必须的（case10），
 *       不能一刀切；TS 的 `constructor.length` 变化（原本 n，变成 0），
 *       依赖 `Class.length` 的 DI 框架会错。
 */
async function case03_argsTwice() {
  class G {
    // @ts-expect-error
    async constructor({ v = sideEffect('default') } = {}) {
      void v;
    }
  }
  await new G(); // 降级后 'default' 的副作用发生 2 次
}
// # 填充一些args在里面但不使用就可以了
// ✅ 可行：真正的 constructor 只生成不带默认值 / 解构的占位形参（如 `constructor(_0, _1)`），没有副作用，
//    参数只在 [hiddenSym] 里解析一次。占位个数取原 constructor 的 `length`（第一个默认值 / rest 之前的参数数），
//    这样 `Class.length` 也和原来一致。

/**
 * case04 ✅ 【方案缺陷】TS 参数属性 `constructor(private x)`
 *
 * 参数属性的赋值由 TS 编译器插到 constructor 体的开头（super 之后）。
 * 如果 async constructor 带参数属性：赋值该放在同步 constructor 里还是 [hiddenSym] 里？
 *   - 放同步 constructor：x 的赋值早于 async 体，这和原生一致（参数属性在函数体开始前安装），
 *     但 constructor 要保留形参，直接和 case03 冲突
 *   - 放 [hiddenSym]：`new` 之后、init 之前的窗口里（case06）x 是 undefined
 * 提案应规定 async constructor 禁止参数属性，或编译器明确选一种。
 */
async function case04_parameterProperty() {
  class A {
    // @ts-expect-error
    async constructor(private readonly x: number) {
      await 0;
    }
  }
  void A;
}
// # 直接降级为在构造函数体顶部写赋值语句
// ✅ 可行：在 [hiddenSym] 体顶部写 `this.x = x`（派生类放在 `await super[hiddenSym](...)` 之后，与 TS 对 super() 的处理一致）。
//    顺序与原生一致（先于 async 体余下部分）；“new 之后 init 之前 x 是 undefined”的窗口属于 case06 的误用范围，不再单独算问题。

/**
 * case05 ✅ 【方案缺陷】`createInstance` 只支持单个参数
 *
 * plan/subinit.ts 里是 `createInstance(cls, args)`，`new A(a, b)` 要改成 `...args`。
 * 另外 `[hiddenSym](key, ...args)` 把 key 放在参数头部，使得 `Function.prototype.length` /
 * 参数下标都整体偏移 1，类型层面（case21）也要一并处理。
 */
async function case05_multipleArgs() {
  class A {
    // @ts-expect-error
    async constructor(a: number, b: string) {
      void a;
      void b;
    }
  }
  const a = await new A(1, 'x');
  void a;
}
// ✅ 已改：plan/subinit.ts 的 createInstance 现在是 `(cls, ...args)`，内部 `new cls(...args)` 和
//    `inst[hiddenSym](callSym, ...args)`，调用点 `createInstance(A, {})` 与 `new A({})` 一一对应。

/* ========================================================================== *
 * B. 调用验证与误用
 * ========================================================================== */

/**
 * case06 ✅ 【方案缺陷】直接 `new A()` 得到半初始化对象，且没有任何报错（已验证）
 *
 * 原生提案中 `new A()` 得到 Promise，忘了 await 至少能被发现（行为和 Promise 一样）。
 * SubInit 里 `new C().d` 是 undefined，不抛错。包括：
 *   - 漏改的调用点
 *   - 第三方库里的 `new this.constructor()`、`Reflect.construct`、`Object.create(proto)` 式克隆
 *   - 测试框架 / DI 容器 / ORM 通过反射 new
 *
 * 修复思路：createInstance 在 `new cls` 前设置 `pendingTarget = cls`。每个 async 类的
 * 真正 constructor 里检查 `new.target === pendingTarget` 并清除标记，不匹配就同步 throw，
 * 把“忘了 await”变成大声失败。
 * 代价：每个类的 constructor 多一次检查；子类的 super() 链上只能由最外层 new.target 校验一次，
 *       子类需要把“我是不是最外层”传下去；并发 createInstance 时 pendingTarget 是全局状态，
 *       要保证 `new` 同步完成（同步构造链可以保证）。
 */
async function case06_bareNew() {
  class C {
    // @ts-expect-error
    async constructor() {
      await 0;
    }
  }
  const c = new C(); // 降级后：c 是未初始化的 C；原生：c 是 Promise
  void c;
}
// # 直接new A不等待不then本身就是错误用法，应当自行承担
// ✅ 已接受：设计决定，不加 pendingTarget 校验。仅保留一个提醒：库内部的反射构造（`new this.constructor()`、
//    `Reflect.construct`）也会落到这里，它们不是调用方的错，但原生语义下同样拿到 Promise，所以不算降级引入的新问题。

/**
 * case07 ✅ 【方案缺陷】callSym 的“调用验证”没有实际作用
 *
 * plan/subinit.ts 里 `key` 参数从未被检查。即使加上检查：
 *   - callSym 是模块级私有的，跨模块的子类和 createInstance 对不上；
 *     要共享就得导出，导出之后任何人都能拿到
 *   - 它只能证明“调用者持有 callSym”，不能证明“这个实例是刚 new 出来的”
 *
 * 修复思路：用 case06 的 pendingTarget，或者在实例上记录状态位（case08），
 * 不要靠 symbol 做验证。
 */
async function case07_callSymNotChecked() {}
// # 现在校验了
// ✅ 已核对：plan/subinit.ts 第 31、49 行，A 和 ASub 的 [hiddenSym] 都有 key 校验，“从未检查”已解决。
//    剩余的“跨模块要共享 symbol”转到 case19，不属于本条。

/**
 * case08 ✅ 【方案缺陷】重复调用 [hiddenSym] 会重复初始化（已验证）
 *
 * `await createInstance(D); await d[hiddenSym](callSym)` 实测 init 跑了 2 次。
 * 原生 async constructor 只能运行一次。
 *
 * 修复思路：每个实例一个“已初始化”状态位，放在 WeakSet 里（不要放实例属性，避免被 Object.keys 看到）：
 *   `if (inited.has(this)) throw ...; inited.add(this)`
 * 代价：多一个 WeakSet 和一次查询；子类调用 super[hiddenSym] 时是同一个 this，
 *       状态位只能挂在最外层的 createInstance 上，不能在每层 [hiddenSym] 里检查。
 */
async function case08_doubleInit() {
  // 前提：跨模块的子类需要 hiddenSym / callSym（case19），所以它们被导出了。
  // 此时 key 校验拦不住任何人：谁拿到 callSym，谁就能重新触发初始化。
  class Conn {
    #conn: any;
    async [hiddenSym](key: symbol) {
      if (key !== callSym) throw new Error('Invalid call to hiddenSym');
      this.#conn = await load(); // 打开连接
    }
  }
  const c: any = await createInstance(Conn);
  await c[hiddenSym](callSym); // 第二次 init：又打开一条连接，第一条泄漏，#conn 被覆盖
  // 原生 async constructor 只会跑一次，没有任何入口能再跑第二次。
}
// ?? 帮我举例
// ⚠️ 上面补了示例。要点：编译器自己生成的代码不会重复调用，只有“符号被导出 + 外部代码手动调用”才会触发，
//    所以优先级取决于你是否接受导出 symbol（case19）。如果 symbol 保持模块私有，这条可以直接划掉。
// # 本就不允许这样做，这是逆天而行。这两个symbol是默认不会被发现的，如果非要认为会发现，那么降级无意义。
// ✅ 同意，划掉：手动调 [hiddenSym] 等于绕过语言层面的构造入口，和手动调 Object.setPrototypeOf 破坏实例同类，
//    不是降级方案要防的东西，WeakSet 状态位也不需要加。
//    唯一要留意的是 case19：跨模块子类确实要拿到 hiddenSym，“不被发现”只能靠约定（不导出到公共 API / 命名约定），
//    不是真正的私有。这条在 case19 里讨论，不影响本条结论。


/**
 * case09 ✅ 【语义偏差】init 失败后实例的状态
 *
 * 原生：`await new A()` reject，调用者拿不到实例，半初始化的对象被丢弃。
 * SubInit：[hiddenSym] reject 时 createInstance 同样 reject，调用者也拿不到实例。看似一致，
 * 但 this 在 async 体里被提前“逃逸”（`registry.add(this)`、`this.on('x', cb)`、传给别的函数）时，
 * 半初始化对象仍然存活，并可能被外部再次触发 [hiddenSym]（case08）。
 * 这在原生 async constructor 里同样存在，只是 SubInit 多了“外部能拿到 [hiddenSym]”这一条入口。
 */
async function case09_initFailure() {}
// # 错的时候是脏对象，这个本来就没用啊。这是正常现象
// ✅ 已接受：init 失败后调用方拿不到实例，与原生一致；this 提前逃逸造成的脏对象，原生里同样存在。


/* ========================================================================== *
 * C. 继承
 * ========================================================================== */

/**
 * !case10 ⚠️ 【方案缺陷】super(...) 的参数在 constructor 里算不出来；父类是同步类 / 内建类 / 第三方类
 *
 * 原文里的 `await super(x)` 之前允许有 async 的计算：
 *   async constructor() { const x = await load(); await super(x); }
 * SubInit 的真正 constructor 是同步的，只能写 `super(args)`，拿不到 x。
 *   - 父类是 SubInit 产物（constructor 为空）：无所谓
 *   - 父类是同步类、内建类、DOM 类（Map、Error、HTMLElement、第三方库）：真正的构造函数需要正确参数，
 *     并且 super() 必须同步调用 -> 无解（与 1.ts case05 同源）
 *
 * plan/subinit.ts 注释里“实际上父类构造函数是空的”只对 SubInit 编译出的类成立。
 * 提案要明确：async constructor 的类，其父类必须是 Object 或另一个 async constructor 的类，否则编译错误；
 * 或者只允许“无参 `super()`”。
 */
async function case10_nonAsyncParent() {
  class MyMap extends Map<string, any> {
    // @ts-expect-error
    async constructor() {
      const entries = await load();
      // @ts-expect-error
      await super(entries); // 实参依赖 await 的结果，SubInit 里无处安放
    }
  }
  void MyMap;
}

// # 它会被词法分析并转换为
class MyMap extends Map<any,any>{
  arg1:any;
  constructor(原本的arg1:any,原本的argN:any,...super依赖的args:any[]) {
    super(super依赖的args);
    // 根据入参设置成员值
    this.arg1 = 原本的arg1
  }
}
// 通过词法分析制作出特有构造工厂：
async function createMyMap(...args: any[]) {
  const entries = await load();
  return Reflect.construct(MyMap, [...args, [entries]], MyMap);
}

// & 可行的原因：一定有一个完整的异步逻辑得到每一个需要初始化的值，那么它就一定能够制作成一个返回这些值的特殊函数，
// & 因此，在工厂函数中调用这个函数就能做到直接获取所有初始化需要的值，再进入构造函数即可。
// ⚠️ 方向对，从【无解】降为【方案缺陷】，但还有四个洞（前两个已用 node 验证）：
//
//  1. 参数槽位法依赖“参数列表形态可控”。父类是第三方 / 内建类时，编译器不知道它有几个形参、
//     有没有 rest：`constructor(a, ...rest)` 的父类会把追加的槽位吞进 rest。
//     实测 `new Kid(1,2,3)`（Kid 的 super 调用是 `super(a, ...superArgs)`）-> rest = [1,2,3]。
//     可行的前提是“把追加值放在固定位置”，而固定位置只能在编译期知道父类签名时才成立。
//  2. 工厂里 `await load()` 的位置要能复现原构造函数里 await 的**相对顺序**：
//     `const a = await x(); const b = await y(a); super(a, b)` 要抽成 `async function f(){ ...; return [a,b] }`，
//     其中对 this / 父类状态的访问要一并改写，否则顺序和依赖关系都变了。
//  3. 多个 async 子类共用一个父类时，每个子类要合并自己 + 父类 + 祖父的预取调用，这要求
//     静态预取函数（如 `static async [preSym](args)`）可继承、可 super 组合（已验证可行）。
//  4. `Reflect.construct(MyMap, [...args, entries], MyMap)` 里父类构造仍可能**返回对象**替换 this
//     （已验证），后续追加的初始化要作用在新 this 上，SubInit 的 [hiddenSym] 拿到的是旧 this。
//
//  另：如果父类只是同步类（没有 async 部分），且 `super()` 的参数不依赖 await，
//  那么真正 constructor 直接 `super(args)` 即可，不需要这套工厂——工厂只对“父类参数依赖 await”或者
//  “父类 async constructor 需要被 await”的情形必要。
// ! 需要再看看


/**
 * case11 ✅ 【方案缺陷】[hiddenSym] 在父类没有 async constructor 时是 undefined
 *
 * `class B extends P { async constructor() { await super(); } }`，P 是普通类（或不同编译单元的类）时，
 * `super[hiddenSym]` 为 undefined，直接调用抛 TypeError。
 * 修复思路：编译成 `await super[hiddenSym]?.(key, ...args)`。
 * 代价：编译期知道 P 一定没有时可以省掉，不知道时（case13）只能保留 `?.`，
 *       并且它会把“父类其实应该是 async 的但忘了编译”的错误静默吞掉。
 */
async function case11_superMayBeMissing() {}
// # 也许问题10的解决方式是更好的方案
// ✅ 同意：把 case10 的静态预取 + 工厂方案推广后，[hiddenSym] 的调用可以统一走
//    `const init = inst[hiddenSym]; if (typeof init === 'function') await init.call(inst, callSym, ...args)`，
//    父类没有 async 部分时自然跳过，不再需要 `?.` 的静默问题。剩下的只是“父类忘编译”的诊断，
//    可以改为运行时检查 `inst instanceof AsyncConstructorBase`（用 preSym 标记原型）。

/**
 * case12 ⚠️ 【方案缺陷】mixin / 装饰器 / Proxy 包装类 要透传 [hiddenSym]
 *
 * `class B extends Mixin(A)`：Mixin 返回的类必须继承自 A（自然透传）；
 * 如果 Mixin 内部写了自己的 constructor 并覆写了 [hiddenSym] 却没调 super，init 链就断了。
 * 类装饰器若返回新类（包装类），`createInstance(Wrapped)` 能找到继承来的 [hiddenSym]，没问题；
 * 若返回的是 Proxy / 工厂函数，则 `new` 的结果不是原来的实例，[hiddenSym] 被调在谁身上也要看具体实现。
 * 与 1.ts case09 同源，但 SubInit 比 throw 方案宽松，因为不需要劫持 constructor 的返回值。
 */
async function case12_mixinAndDecorator() {}
// ! 确实是个问题，这很复杂
// ⚠️ 承认复杂，先记为已知限制，不在第一版处理。可以给的规则：
//    - mixin 必须 `return class extends Base {...}`，不要用 `Object.assign` 复制方法（已验证：class 方法不可枚举，
//      Object.assign 不会复制 symbol key，但很多 mixin 库用 `getOwnPropertyNames`/`ownKeys` 手动复制，符号会丢）
//    - 装饰器返回的包装类必须 `extends` 原类；返回 Proxy 时 `createInstance` 会在代理对象上找 [hiddenSym]，
//      通过 get 陷阱能拿到原型上的方法，init 里的 `this` 是代理，与原生的一致
//    - 编译器无法校验这件事，只能写进文档

/**
 * case13 ✅ 【方案缺陷】编译期不知道继承链上有没有 async constructor
 *
 * 子类 `class B extends Lib.Base { ... }`，Base 是否 async 取决于另一个包。
 * 编译器不知道是否要把 B 改成 async、是否要写 `?.`、调用点要不要 await（case18）。
 * 只能靠类型声明（case21）或者要求用户显式标注。与 1.ts case08 同源。
 */
async function case13_unknownParent() {}
// # 存在[hiddenSym]就视作“有”
// ✅ 可行，而且和 case11 的运行时检查是同一件事：不在编译期判断，改在 createInstance 里
//    `typeof inst[hiddenSym] === 'function'`。这样就只需要编译器知道“当前类自己有没有 async 部分”，
//    不需要知道整条继承链——除非父类是跨包且没被本编译器编译过（那时它根本没有 [hiddenSym]，
//    会被当成同步类，父类的异步初始化被静默跳过）。这一点要写进提案：跨包继承异步父类时，
//    父包必须由同一编译器产出，或者依赖 .d.ts 里的标记在编译期报错。

/* ========================================================================== *
 * D. 构造函数体语义
 * ========================================================================== */

/**
 * case14 ✅ 【方案缺陷】`new.target` 在 [hiddenSym] 里是 undefined（已验证）
 *
 * 真正的 constructor 里 `new.target` 是 H，被搬进 [hiddenSym] 的代码读到 undefined。
 * 修复思路：在真正的 constructor 里 `this[ntSym] = new.target`，[hiddenSym] 里的 new.target 改写为
 * `this[ntSym]`；或者由 createInstance 作为参数传进去（`inst[hiddenSym](callSym, cls, ...args)`）。
 * 代价：多一个槽位；Reflect.construct(A, args, Other) 的第三个参数 newTarget 不经过 createInstance，
 *       只能走“在 constructor 里存”的方案。
 * 抽象类检查 `if (new.target === Abstract) throw` 是最常见的触发场景。
 */
async function case14_newTarget() {
  class H {
    // @ts-expect-error
    async constructor() {
      if (new.target === H) {
        /* 原生下是 H；SubInit 下是 undefined */
      }
    }
  }
  void H;
}
// # new.target本来就不能完美模拟，可以接受，babel都做不到
// ✅ 接受，但降级其实**能**做对，成本很低：真正的 constructor 里 `new.target` 是准确的，
//    只要生成 `this[newTargetSym] = new.target`，[hiddenSym] 里的 `new.target` 改写成 `this[newTargetSym]` 即可。
//    这个槽位同样可以被 case10 的工厂 `Reflect.construct(..., MyMap)` 覆盖到。
//    不过如果提案本身打算禁止“抽象类 check”之外的用法，那接受不模拟也没问题。

/**
 * case15 ✅ 【方案缺陷】构造函数里的 `return` 语义丢了
 *
 * [hiddenSym] 的返回值被 createInstance 忽略。
 *   - `return;` 提前结束：搬进 async 方法后行为一致，没问题
 *   - `return otherObject;`：原生 constructor 会用它替换 this；
 *      async constructor 里就是 `await new A()` 的结果。SubInit 里 createInstance 要改成
 *      `const r = await inst[hiddenSym](...); return r ?? inst`，且 r 是原始值时要忽略
 *   - 父类 return 对子类 this 的影响：`await super()` 之后子类的 this 变成了父类返回的对象，
 *     子类的字段（case01）已经装在旧 this 上，新 this 上没有，且 #私有字段更会因为品牌检查失败而抛 TypeError
 * 提案建议直接禁止 async constructor 里 `return 非 undefined`。
 */
async function case15_return() {}
// ! 不会允许构造函数return
// ✅ 同意（提案层面禁止）。补充一点：这只约束 async constructor 的**类体**；
//    父类若是第三方同步类且构造函数 return 了对象，派生类 `this` 会被替换（已验证：`new R()` 的 this 变为 `{quest:1}`，
//    之后在派生类里对 this 的写入落到新对象上）。这条对同步类本来就存在，SubInit 不额外加问题，
//    但 case10 的工厂 `Reflect.construct` 之后，[hiddenSym] 拿到的若是旧 this 就会写丢，所以工厂里必须用返回值。

/**
 * case16 ✅ 【方案缺陷】TS 严格检查：属性初始化 / readonly
 *
 *   - `strictPropertyInitialization`：`#data: any` 没有初始化器，真正的 constructor 是空的，
 *     赋值在 [hiddenSym] 里，TS 报“属性没有初始化”。需要 `!` 断言或者生成代码里就放宽
 *   - `readonly` 属性只能在 constructor 里赋值，[hiddenSym] 里赋值是 TS 编译错误（TS2540）。
 *     降级产物如果还要通过 TS 检查，需要 `(this as any).x = ...` 之类的逃生舱
 *   - 如果降级产物只用作 JS 输出，这条无影响；若还要保留 .d.ts / 二次类型检查，需要处理
 */
async function case16_tsChecks() {
  class A {
    readonly id: number;
    // @ts-expect-error
    async constructor() {
      await 0;
      this.id = 1; // 降级后在 [hiddenSym] 里赋值 readonly
    }
  }
  void A;
}
// # 降级方案针对从ts直接到js，js里没有这个问题
// ✅ 对输出而言成立。但要注意一个中间态：`tsc` 在**降级之前**仍要类型检查源码，
//    而源码里 `this.id = 1` 写在 async constructor 里，TS 会认为它是合法的（如果 TS 支持这种语法的话）；
//    降级产物若不再做二次检查，就没事。若采用“先降级成 TS 再交给 tsc”的管线，则会撞上 TS2540。
//    另外 `strictPropertyInitialization` 对 `#data: any` 的“未初始化”报错是针对**源码**的，
//    而源码里赋值确实在 constructor 中，所以也不报。结论：只要不二次检查降级产物，本条可以划掉。

/**
 * case17 ✅ 【方案缺陷】构造函数体的 `this` 转义
 *
 * 在原生 async constructor 里，`this` 在第一个 await 前可以被传出去（`registry.add(this)`）。
 * SubInit 下 this 在 createInstance 外部同样可见，但 init 开始的时间点变化了：
 * 同步构造链结束 -> createInstance 调用 [hiddenSym]，中间虽然是同步的，没有事件循环间隙，
 * 但 `new cls()` 的同步链里已经执行过子类字段初始化器（case01），
 * 它们里面若把 this 传出去，外界看到的是“字段已装、async 体未跑”的状态。
 */
async function case17_thisEscape() {}
// # 这是坏实践，不该这样写
// ✅ 同意，划掉：this 在 init 完成前逃逸到外部本来就应该由使用者保证不发生（原生 async constructor
//    里同样存在，只是窗口位置不同）。如果将来要防，可以在 [hiddenSym] 里加一个“Init 完成后才允许对外暴露”的
//    assert，但那是运行时开销，第一版不做。

/* ========================================================================== *
 * E. 调用点（与 1.ts 共通，只做索引）
 * ========================================================================== */

/**
 * case18 ✅ 【方案缺陷】SubInit 只解决了“类内部”的问题，没有解决“类外部”的问题
 *
 * 调用点改写成 `await createInstance(A, args)` 后，下面这些问题与降级方案无关，
 * 和 1.ts B 组完全一样：
 *   - 不能 await 的语法位置（1.ts case10）：参数默认值、同步回调、字段初始化器、getter……
 *   - 求值顺序与短路（1.ts case11）：`f(new A(), g())`、`cond && new A()`、`new A().x` 链式调用
 *   - 不 await 的 new 拿到的不是 Promise（1.ts case12）：并发 / 保存 promise / 竞速都要重写
 *   - 编译期无法确定某个 new 是不是 async 构造（1.ts case13）
 *   - 类型系统：`new A()` 的类型是 A，而不是 Promise<A>（1.ts case15）
 * SubInit 的好处：createInstance 返回实例本身，不存在 1.ts case14（try/catch 吞掉被抛出的 promise）和
 *                  case22（实例是 thenable）这两类问题。
 */
async function case18_callSites() {}
// # 我不知道你在胡说什么
// # 这个我已经加入了normal.ts顶部的正常现象范围。 不await的new一定是返回promise的，因为实际调用的是个async工厂。
// ✅ 我上一条写得混乱，这里说清楚。normal.ts 定的是**提案语义**：`new A()` 是 Promise。SubInit 是**降级实现**，
//    它要做到这一点，调用点必须改写成 `createInstance(A, ...)`。原答案里“不 await 的 new 拿到的不是 Promise”
//    描述的是“漏改的调用点”的后果，不是提案语义——你这句纠正成立。
//    验证过两种改写都可以满足 normal.ts：
//      a) 全异步：`async function createInstance(...)` 永远返回 Promise。缺点：纯同步类也被包成 Promise（thenable 化）。
//      b) 多态：`createInstance` 里 `typeof inst[hiddenSym] === 'function' ? init().then(() => inst) : inst`，
//         同步类同步返回实例，async 类返回 Promise；`await` 对两者都成立（已验证）。
//    真正剩下的问题只有一条，且与降级无关：**编译器必须能识别每个 new 是不是 async 构造**，
//    否则改写成 `createInstance` 时漏改或错改（`new this.constructor()`、`Reflect.construct`、跨包 new）。
//    所以 1.ts B 组里“不能 await 的语法位置”“短路/求值顺序”仍然有效，但那是“调用点改写”的难度，
//    不是“返回值语义”的问题。

/* ========================================================================== *
 * F. symbol 的工程问题
 * ========================================================================== */

/**
 * case19 ✅ 【方案缺陷】模块级 `Symbol()` 在多份运行时之间不通
 *
 * 多版本 / 多 bundle / 同一份源码被打包两次时，各自有一个 hiddenSym，
 * A 的 [hiddenSym_1] 和子类的 `super[hiddenSym_2]` 对不上，覆写链断了，
 * 且不会报错（case11 的 `?.` 会静默吞掉）。
 * 改用 `Symbol.for('tspp.hiddenInit')` 可以跨份共享，但不再是私有的：任何代码都能拿到并调用 [hiddenSym]（case07、case08）。
 * 取舍：私有性 vs 跨 bundle 互通。大多数库场景需要互通。
 */
async function case19_symbolIdentity() {}
// # 可以用symfor或者其他符号。会被发现这件事是无所谓的，因为所有框架都这么做，没事的
// ✅ 接受：用 `Symbol.for('tspp.hiddenInit')`（或带版本号的 key）解决跨 bundle / 多副本问题。
//    与 case07/08 的结论一致：被发现也无所谓。
//    一个可选加强：再加一个 `hiddenSym[Symbol.hasInstance]` 之类的标记，或者用 `Symbol.for` 前缀带提案版本号，
//    方便未来多版本共存时诊断（同名的 Symbol.for 会跨版本共享，语义不同就会静默串味）。

/**
 * case20 ✅ 【方案缺陷】Reflect.ownKeys / 反射 / 序列化会看到 [hiddenSym]
 *
 * plan/subinit.ts 里写“会被 Reflect.ownKeys 遍历出来，但没关系，可以接受”。需要补充的实际影响：
 *   - `Object.getOwnPropertySymbols(A.prototype)` 多出一项，快照测试 / 原型比较工具会注意到
 *   - 通过原型链复制方法的工具（mixin 库、`Object.assign(Target.prototype, A.prototype)`）会把它一起复制
 *   - Vue / MobX 等响应式系统对原型方法的包装会包到 [hiddenSym] 上，引起额外的代理开销
 * 方法设成不可枚举（`Object.defineProperty`）可以减轻前两项，需要放弃 class 方法的简写语法。
 */
async function case20_reflection() {}
// # 降级带来的正常现象，默认看不见，没事的
// ✅ 接受，并且我原文有两处说错了（已验证）：class 方法（包括 symbol 计算属性名方法）本来就**不可枚举**，
//    所以 `for-in` / `Object.keys` / `JSON.stringify` 都看不见它；
//    `Object.assign(Target, A.prototype)` 也**不会**复制它（实测复制结果里没有 symbol key）。
//    真正能看见的只有 `Reflect.ownKeys` / `Object.getOwnPropertySymbols`，以及手动按 ownKeys 复制方法的工具。
//    Vue/MobX 对原型方法的代理也只会经过 get 陷阱，不构成额外负担。这条可以降级为“文档提醒”。

/**
 * case21 ✅ 【方案缺陷】类型声明（.d.ts）与结构类型
 *
 *   - 计算属性 key 出现在声明文件里要求 symbol 是导出的 `unique symbol`，不导出则声明文件生成失败；
 *     导出后 hiddenSym 变成了公共 API
 *   - 结构类型上，所有 async 类都多了一个同名成员：A 与 B 在不相关的情况下因为都有 [hiddenSym] 而更“相似”；
 *     反过来，别的类对象字面量赋值给 A 类型时会因为缺 [hiddenSym] 报错
 *   - `new A()` 在类型上仍然是 A（1.ts case15）；`createInstance` 需要重载成
 *     `<T extends new (...a: any) => any>(c: T, ...a: ConstructorParameters<T>) => Promise<InstanceType<T>>`
 *   - 参数前面多出 `key` 后，[hiddenSym] 的签名与子类覆写的参数类型要保持一致
 */
async function case21_types() {}
// # 没事的
// ✅ 接受。实现上只需注意两点：hiddenSym 声明成导出的 `unique symbol`（消除 TS4094），
//    以及 createInstance 的签名用 `ConstructorParameters` / `InstanceType` 推导，不要让调用点手写泛型。
//    结构类型“多一个共同成员”的影响在实践里很小（类型上它是原型方法，实例类型不会因此互斥）。

/* ========================================================================== *
 * G. 其他
 * ========================================================================== */

/**
 * case22 ✅ 【语义偏差】错误与栈信息
 *
 * 栈里会多出 `createInstance` 和 `[hiddenSym]` 两层，逐层 `super[hiddenSym]` 使得栈深翻倍；
 * 报错栈里看到的是方法名 `[hiddenSym]` 而非 `new A`。需要 sourcemap / 函数名重命名（name 属性设成 `A`）才能接近原生。
 * 同步部分抛错（真正 constructor 里）与异步部分抛错（[hiddenSym] 里）一个同步抛、一个 reject，
 * createInstance 是 async 函数，两者都会变成 reject，这一点反而更接近原生。
 */
async function case22_stack() {}
// # 没事的，这还省去了promisetry吧？
// ✅ 接受。补充：你说得对，与 1.ts 的 throw-promise 方案相比，SubInit 不需要 `try/catch` 捕获被抛出的 promise
//    （1.ts case14 那类问题不存在），这是 SubInit 的主要优势之一。这里只剩“栈里多两层”的观感问题。
//    可以用 `Object.defineProperty(fn, 'name', { value: 'A' })` 让报错栈显示得更接近原生（可选）。

/**
 * case23 ✅ 【语义偏差】性能
 *
 * 每次构造多一次 async 函数调用与 Promise 分配；子类每多一层继承多一层 `await super[hiddenSym]()`，
 * 微任务数线性增长。没有 async 体的类（只有同步初始化）也无法被免除，
 * 除非编译器能证明链上所有 async constructor 都没有真正的 await，才可以回退成普通 constructor。
 */
async function case23_perf() {}
// # 降级的正常现象
// ✅ 接受。若将来在意，可加一条优化：整条继承链上都没有真正的 `await`（全部是同步表达式）时，
//    回退成普通 constructor + 直接同步执行，仅保留符号方法做兼容。这条优化可以以后再考虑。

/**
 * case24 ⚠️ 【方案缺陷】静态成员 / 静态块 / 类表达式
 *
 *   - 静态块里的 `new A()`：静态块不能 await（1.ts case10 同源）
 *   - 类表达式 `const A = class { async constructor() {} }`：没有类名，error 栈 / `A.name` 要靠
 *     赋值推断，编译器改写后需要保持 name 不变
 *   - 嵌套类 / 类内部的 `new this.constructor()` / `new.target`：编译期无法识别为 async 构造（case06）
 */
async function case24_staticAndExpression() {}
// # 降级的正常现象
// ⚠️ 前两条（栈 / name）可以算正常现象，但这两条不是——会出现实际错误：
//    - 静态块里的 `new A()`：静态块不能 await，而 SubInit 要求你改成 `await createInstance(A)`，
//      二者冲突 -> 要么提案禁止静态块里 new async 类（编译错误），要么用户外包一层
//    - `new this.constructor()` / `Reflect.construct`：编译期识别不了，会走裸 `new`，得到未初始化实例（case06），
//      而这条恰恰不是“误用”，是正常的库内部写法（克隆、工厂、ORM 的 hydrate）。
//    建议：提案里把“静态块内 new async 类”列为编译错误；`new this.constructor()` 则写进已知限制。
// # 意思是不允许这样写。既然已经知道是async的，为何还要在必须sync的位置写它