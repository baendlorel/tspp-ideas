# async constructor SubInit 降级规则

本文整理 [src/edge-cases/1.ts](../src/edge-cases/1.ts)、[src/edge-cases/2.ts](../src/edge-cases/2.ts) 共 24 个 case 的结论，
形成「能干什么、不能干什么、接受什么偏差、还剩哪些缺陷」的规则清单。
提案语义见 [src/plan/normal.ts](../src/plan/normal.ts)，降级实现见 [src/plan/subinit.ts](../src/plan/subinit.ts)。

## 0. 总体语义

- **提案语义**：`async constructor` 的类，`new A(args)` 返回 `Promise<A>`；
  `await new A(args)` 得到实例。不 await 的 `new` 得到 Promise，行为与 Promise 一致，`instanceof` 也成立。
- **传染性**：子类继承 async 父类时，子类也必须是 async 构造，不写 `async constructor` 报编译错误。
- **SubInit 降级**：真正的 constructor 只做同步的 `super(...)` 和字段安装；
  构造函数体迁移到 `[hiddenSym](callSym, ...args)`；调用点改写为 `createInstance(A, ...args)`。
  `createInstance` 返回 Promise（多态实现下，纯同步类可同步返回实例，`await` 对两者都成立）。

编译产物约定：

```js
const hiddenSym = Symbol.for('tspp.asyncConstructor'); // 跨 bundle/多副本共享
const callSym   = Symbol.for('tspp.asyncConstructor.call');

async function createInstance(cls, ...args) {
  const inst = new cls(...args);
  const init = inst[hiddenSym];
  if (typeof init !== 'function') return inst;       // 父类没有 async 部分
  await init.call(inst, callSym, ...args);
  return inst;
}
```

每个生成的 `[hiddenSym]` 开头都必须有 `if (key !== callSym) throw new Error(...)`。

---

## 1. 可以做什么（R：允许并支持的写法）

| 编号 | 规则 | 对应 case |
|---|---|---|
| R1 | 构造函数可以有多个参数、默认值、解构、rest。真正的 constructor 只生成无副作用的占位形参（个数取原 `length`），参数只在 `[hiddenSym]` 里解析一次 | case03、case05 |
| R2 | 支持 TS 参数属性 `constructor(private x)`。降级为 `[hiddenSym]` 体顶部的赋值（派生类放在 `await super[hiddenSym](...)` 之后） | case04 |
| R3 | `#私有字段`、`private`/`protected`、`super.method()`、`instanceof`、原型链全部保留（SubInit 不破坏类结构） | — |
| R4 | `createInstance(cls, ...args)` 支持任意个参数，与 `new A(a, b)` 一一对应 | case05 |
| R5 | 子类可以覆写 `[hiddenSym]` 并 `await super[hiddenSym](key, ...args)`；隐式构造函数（`class C extends A {}`）自动继承父类初始化 | — |
| R6 | 跨模块 / 多 bundle / 多份运行时：用 `Symbol.for`（或等价方案）共享两个 symbol；被发现无所谓 | case19 |
| R7 | `.d.ts` 中 `hiddenSym` 声明为导出的 `unique symbol`；`createInstance` 用 `ConstructorParameters` / `InstanceType` 推导 | case21 |
| R8 | 父类没有 async 部分时，运行时用 `typeof inst[hiddenSym] === 'function'` 判断并跳过，不用 `?.` | case11、case13 |
| R9 | 父类是同步类且 `super()` 参数不依赖 await 时，直接同步 `super(args)`，不需要静态预取工厂 | case10（部分） |
| R10 | 接受 `new.target` 不精确模拟。若需要，可在真正的 constructor 里存 `this[newTargetSym] = new.target`，低成本且准确 | case14 |

## 2. 必须遵守的规则（M：编译/实现的硬性要求）

| 编号 | 规则 | 依据 |
|---|---|---|
| M1 | 子类必须写 `async constructor`；不写（同步子类）是编译错误 | normal.ts 传染性、case02 |
| M2 | 每个生成的 `[hiddenSym]` 都必须校验 `key === callSym` | case07 |
| M3 | `createInstance` 必须展开参数：`new cls(...args)`、`init.call(inst, callSym, ...args)` | case05 |
| M4 | 降级产物只输出 JS，不再对降级结果做二次 TS 检查（避免 readonly / 属性未初始化误报） | case16 |
| M5 | 编译器必须能识别每个 `new X()` 是不是 async 构造，才能正确改写成 `createInstance` | case18 |
| M6 | 跨包继承 async 父类时，父包必须由同一编译器产出；否则父类没有 `[hiddenSym]`，会被当成同步类、静默跳过异步初始化 | case13 |

## 3. 禁止的写法（F：编译错误或明确不支持）

| 编号 | 禁止项 | 说明 | 对应 case |
|---|---|---|---|
| F1 | async constructor 中 `return` 非 `undefined` 的值 | 会改变构造结果语义 | case15 |
| F2 | 在必须同步的位置 `new` async 类：静态块、字段初始化器、参数默认值、getter、同步回调等 | 编译错误；既然已知是 async，就不该在必须同步的位置写 | case18、case24 |
| F3 | 手动调用 `[hiddenSym]` / 伪造 `callSym` | 属绕过构造入口的“逆天”用法，降级不负责防 | case08 |
| F4 | 直接 `new A()` 而不等待 / 不 then | 得到未初始化对象，属用户误用，自行承担；不做运行时校验 | case06 |
| F5 | 在 init 完成前把 `this` 逃逸给外部（`registry.add(this)` 等） | 坏实践，降级不额外防护 | case17 |
| F6 | 依赖“子类字段在父类 async 体之后安装”的顺序 | SubInit 下顺序为：父类字段 → 子类字段 → 父类 async 体 → 子类 async 体余下部分 | case01 |

## 4. 接受的语义偏差（D：可接受，写进文档）

| 编号 | 偏差 | 实测/说明 | 对应 case |
|---|---|---|---|
| D1 | 子类字段初始化早于父类 async 部分 | `class B extends A { x = 'sub-field' }` 且父类 async 体赋 `x` 时，最终值为父类的值 | case01 |
| D2 | 构造函数参数里的默认值/解构副作用只应发生一次 | 由 M/占位形参修复，不属最终偏差 | case03 |
| D3 | init 失败后留下“脏对象” | 调用方拿不到实例；`this` 提前逃逸时才可能残留，原生同样存在 | case09 |
| D4 | `new.target` 在 `[hiddenSym]` 里不自动可用 | 接受；需要时用 R10 的槽位 | case14 |
| D5 | `Reflect.ownKeys` / `getOwnPropertySymbols` 能看到 `[hiddenSym]` | class 方法本身不可枚举，`for-in` / `Object.keys` / `JSON.stringify` / `Object.assign` 都看不到 | case20 |
| D6 | 报错栈多出 `createInstance` 和 `[hiddenSym]` 两层 | 可用 `defineProperty(fn, 'name')` 改善；相比 throw-promise 方案省去 try/catch | case22 |
| D7 | 每次构造多一次 async 调用和 Promise 分配 | 降级的正常代价；将来可对“整条链无真实 await”回退为同步构造 | case23 |
| D8 | 类型上 `new A()` 仍是 `A`，`createInstance` 返回 Promise | 由 R7 的类型推导弥补 | case21 |

## 5. 缺陷（B：尚未解决 / 待定）

### 缺陷1：父类构造函数参数依赖 await（case10）

`async constructor` 中 `const x = await load(); await super(x);`，当父类是同步类 / 内建类 / 第三方类时，
真正的 constructor 是同步的，拿不到 `x`。

- 方向：静态预取 + 工厂（`static async [preSym]` 汇总父类需要的值，`Reflect.construct` 进入构造函数）。
- 尚未解决的四个洞：
  1. 父类有 rest 参数时，追加的槽位会被吞进 rest（已实测）。
  2. 工厂中 `await` 的相对顺序与依赖关系需要完整复现。
  3. 多层继承需合并各级预取，静态预取本身可 super 组合（已验证）。
  4. 父类构造 `return` 对象替换 `this` 时，后续初始化要作用在新 `this` 上（已实测）。
- 状态：**待定（需要再看看）**。第一版可以先把 F4 作为限制：父类参数依赖 await 的情形不支持。

### 缺陷2：mixin / 装饰器 / Proxy 包装类（case12）

`[hiddenSym]` 必须沿继承链透传，编译器无法校验：

- mixin 必须 `return class extends Base {...}`，不要用 `Object.assign` / 手动 `ownKeys` 复制方法；
- 装饰器返回的包装类必须 `extends` 原类；
- 返回 Proxy 时，`createInstance` 通过 get 陷阱拿到原型上的方法，`this` 是代理，与原生一致；
- 若包装类自己覆写了 `[hiddenSym]` 却没调 `super`，初始化链静默断裂。

状态：**已知缺陷**，第一版记为限制并写入文档，不做编译期检查。

### 缺陷3：编译期无法识别某些 `new` 形态（case18、case24）

`new this.constructor()`、`Reflect.construct`、跨包 `new`、嵌套类内部构造，编译器无法判断是否要改写成
`createInstance`。这类写法不是误用（克隆、工厂、ORM hydrate 常用），会走到裸 `new`，得到未初始化实例（F4）。

状态：**已知限制**，写入文档；F2 中的静态块等位置改为编译错误以缩小影响面。

---

## 6. Case → 结论对照表

| case | 主题 | 结论 |
|---|---|---|
| 01 | 子类字段初始化顺序 | 接受偏差（D1） |
| 02 | 同步子类 | 不是偏差；提案层面由 M1 保证 |
| 03 | 参数求值两次 | 已解决：占位形参（R1） |
| 04 | TS 参数属性 | 已解决：`[hiddenSym]` 顶部赋值（R2） |
| 05 | 多参数 `createInstance` | 已解决：`...args`（R4） |
| 06 | 裸 `new` | 用户误用，不防（F4） |
| 07 | `callSym` 校验 | 已解决：每个 `[hiddenSym]` 统一校验（M2） |
| 08 | 重复初始化 | 划掉：手动调用属逆天用法（F3） |
| 09 | init 失败后的脏对象 | 接受偏差（D3） |
| 10 | 父类参数依赖 await | **缺陷1，待定** |
| 11 | 父类无 `[hiddenSym]` | 已解决：运行时 typeof 判断（R8） |
| 12 | mixin / 装饰器 / Proxy | **缺陷2，已知限制** |
| 13 | 继承链在编译期不可知 | 已解决：存在 `[hiddenSym]` 即视作有；跨包限制见 M6 |
| 14 | `new.target` | 接受；可用槽位做准（R10、D4） |
| 15 | 构造函数 `return` | 禁止（F1） |
| 16 | TS 严格检查 | 只输出 JS，不做二次检查（M4） |
| 17 | `this` 提前逃逸 | 坏实践，不防（F5） |
| 18 | 调用点改写 | 编译器识别是硬性要求（M5）；返回值语义由 `createInstance` 满足 |
| 19 | symbol 跨副本 | 已解决：`Symbol.for`（R6） |
| 20 | 反射可见性 | 接受偏差（D5） |
| 21 | `.d.ts` 与类型 | 已解决：`unique symbol` + 类型推导（R7） |
| 22 | 栈信息 | 接受偏差（D6） |
| 23 | 性能 | 接受偏差（D7） |
| 24 | 静态块 / 类表达式 | 静态块内 `new` 禁止（F2）；其余见缺陷3 |

## 7. 参考

- 提案语义：[src/plan/normal.ts](../src/plan/normal.ts)
- SubInit 降级实现：[src/plan/subinit.ts](../src/plan/subinit.ts)
- throw-promise 方案：[src/plan/throw.ts](../src/plan/throw.ts)
- 边界情况原文：[src/edge-cases/1.ts](../src/edge-cases/1.ts)、[src/edge-cases/2.ts](../src/edge-cases/2.ts)
