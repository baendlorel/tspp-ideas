# async constructor SubInit 规则

本文只列**使用者要遵守的规则**，以及编译器如何把提案语法降级成普通 JS。
结论来源：[src/edge-cases/1.ts](../src/edge-cases/1.ts)、[src/edge-cases/2.ts](../src/edge-cases/2.ts)；
提案语义见 [src/plan/normal.ts](../src/plan/normal.ts)，降级实现见 [src/plan/subinit.ts](../src/plan/subinit.ts)。

---

## 一、可以做什么

- `async constructor` 可以有任意参数、默认值、解构、rest，以及 TS 参数属性 `constructor(private x)`。
- 构造函数体里可以使用 `#私有字段`、`private`/`protected`、`super.method()`、`await`。
- 子类继承 async 父类时，子类也写 `async constructor`，用 `await super(args)` 调用父类部分。
- `await new A(args)` 得到实例；不 `await` 的 `new A(args)` 得到 `Promise<A>`，行为与 Promise 一致。
- 子类可以不写 `constructor`（隐式构造函数），自动继承父类的异步初始化。
- `new.target` 可以使用，编译器会还原。

---

## 二、禁止的写法

### F1. 构造函数里 `return` 非 `undefined` 的值

```ts
async constructor() {
  return other; // ❌ 编译错误
}
```

原因：构造函数 return 会替换实例，异步部分无法表达这个替换。
`return;`（提前结束）是允许的。

### F2. 直接 `new A()` 后不等待

```ts
const a = new A(); // ❌ 得到的是半初始化对象，不是 Promise
a.method();        // 运行时才暴露问题
```

原因：降级后 `new` 不经过异步工厂，得到的是真正的 constructor 跑完、但异步初始化尚未执行的实例。
这是调用方的错误，编译器不做运行时校验。

### F3. 依赖「子类字段在父类异步部分之后安装」

```ts
class A {
  x: any;
  async constructor() {
    this.x = 'parent';
  }
}
class B extends A {
  x = 'sub'; // ❌ 不要依赖它可以覆盖父类的赋值
}
```

SubInit 下的顺序是：

```
父类字段 → 子类字段 → 父类 async 体 → 子类 async 体余下部分
```

原生语义下子类字段应晚于父类 async 体安装。这个偏差已被接受，用户需要自己避免依赖顺序。

### F4. 在异步初始化完成前把 `this` 交给外部

```ts
async constructor() {
  registry.add(this); // ❌ init 完成前 this 已逃逸
  await load();
}
```

坏实践。降级不额外防护，外部可能拿到半初始化对象。

### F5. 手动调用内部的 `[hiddenSym]` / 伪造 `callSym`

绕过语言层面的构造入口，等同于手动 `Object.setPrototypeOf` 破坏实例。降级不负责拦截。

### F6. 让同步子类继承 async 父类

```ts
class A { async constructor() {} }
class B extends A {
  constructor() { super(); } // ❌ 必须写 async constructor
}
class C extends A {} // ✅ 隐式构造函数可以
```

传染性：子类不写 `async` 是编译错误。

---

## 三、需要注意：同步位置 `new` 只得到 Promise

这不是禁止写法。在不能 `await` 的位置 `new` async 类，语法上完全合法，
但**得到的值是 `Promise<A>`，不是 `A`**。如果你在这个位置需要的是实例，那就是写错了；
如果只是发起构造、稍后再用，留着 Promise 即可。

```ts
class A { async constructor() { await load(); } }

class Holder {
  static {
    const p = new A();       // p 是 Promise<A>，这里不能 await
    // 存起来，之后在 async 方法里 await
  }

  field = new A();            // 字段的值是 Promise<A>，不是 A
  pending: Promise<A> = new A(); // ✅ 类型写对就行

  method(x = new A()) {       // ✅ 默认值是 Promise<A>
    return x;                  // 返回 Promise<A>
  }

  get value() { return new A(); } // ✅ 返回 Promise<A>
}
```

几点提醒：

- 编译器照常把这些 `new` 改写成 `createInstance(A, ...)`，返回值就是 Promise。
- 类型层面 `new A()` 是 `Promise<A>`，用在需要 `A` 的位置会被类型检查拦下。
- 不接住这个 Promise 时，异步初始化失败会变成未处理的 rejection（与直接用 Promise 一样）。
- 如果构造的用意是立即得到实例，就必须把它移到能 `await` 的位置（通常是改成 async 方法）。

---

## 四、需要知道的语义差异

| 差异 | 说明 |
|---|---|
| 字段顺序 | 见 F3。`useDefineForClassFields` 语义不变。 |
| `new.target` | `[hiddenSym]` 是普通方法，`new.target` 不自动可用。编译器会在 constructor 里记录并通过槽位还原，`Reflect.construct(A, args, Other)` 也正确。 |
| 符号可见性 | `[hiddenSym]` 可通过 `Reflect.ownKeys` / `Object.getOwnPropertySymbols` 看到。class 方法不可枚举，`for-in`、`Object.keys`、`JSON.stringify`、`Object.assign` 都看不到。 |
| 报错栈 | 多出 `createInstance` 和 `[hiddenSym]` 两层。 |
| 性能 | 每次构造多一次 async 调用和 Promise 分配；每层继承多一次 `await super[hiddenSym]()`。 |
| 类型 | 源码里 `new A()` 的类型是 `Promise<A>`；调用点由编译器改写成 `createInstance`，类型用 `ConstructorParameters` / `InstanceType` 推导。 |

---

## 五、编译器降级步骤

### 步骤 0：前置分析

- 标记所有带 `async constructor` 的类（下称 async 类）。
- 对每个 async 类检查：子类是否也写了 `async constructor`（F6）；构造函数是否 `return` 非 undefined（F1）。
- 收集所有 `new` async 类的位置，标记其中位于同步位置、无法 `await` 的调用（见第三节，不是错误，但要保留类型信息）。
- 检查父类：父类必须是 async 类或 `Object`。父类是同步类且 `await super()` 的参数依赖 `await` 时，进入步骤 9（待定）。

### 步骤 1：注入运行时

在模块顶部注入两个 symbol 与工厂：

```js
const hiddenSym = Symbol.for('tspp.asyncConstructor');
const callSym   = Symbol.for('tspp.asyncConstructor.call');

async function createInstance(cls, ...args) {
  const inst = new cls(...args);
  const init = inst[hiddenSym];
  if (typeof init !== 'function') return inst;   // 父类没有异步部分
  await init.call(inst, callSym, ...args);
  return inst;
}
```

`Symbol.for` 保证多份 bundle / 多个运行时实例看到同一个符号。

### 步骤 2：拆分构造函数体

对每个 async 类：

- 新增成员 `async [hiddenSym](key, ...args)`，函数体是原 constructor 的函数体。
- `[hiddenSym]` 第一句插入 `if (key !== callSym) throw new Error('Invalid call to hiddenSym');`。
- 真正的 `constructor` 只保留 `super(...)`（派生类）和占位形参。

```js
// 源码
class A {
  #data;
  async constructor(args) { this.#data = await load(args); }
}

// 降级
class A {
  #data;
  constructor(_0) {}
  async [hiddenSym](key, ...args) {
    if (key !== callSym) throw new Error('Invalid call to hiddenSym');
    this.#data = await load(args[0]);
  }
}
```

占位形参的个数取原 constructor 的 `length`（第一个默认值或 rest 之前参数个数），
形参名用 `_0`, `_1`…，不带默认值和解构，避免参数副作用。
参数只在 `[hiddenSym]` 里解析一次。

### 步骤 3：改写子类的 `super`

```js
// 源码：await super(args)
// 降级：
constructor(...) {
  super(true); // 占位，父类 constructor 是空的
}
async [hiddenSym](key, ...args) {
  if (key !== callSym) throw ...;
  await super[hiddenSym](key, ...args);
  // 原子类构造函数体余下部分
}
```

隐式构造函数的子类不需要步骤 3：它自动继承父类的 `[hiddenSym]`，
`createInstance` 调用到的就是父类那一份。

### 步骤 4：参数属性

```js
// 源码：async constructor(private readonly x: number)
// 降级：写在 [hiddenSym] 顶部
async [hiddenSym](key, x) {
  if (key !== callSym) throw ...;
  this.x = x;            // 派生类放在 await super[hiddenSym](...) 之后
  // ...
}
```

赋值位置与 TS 处理普通参数属性一致：在函数体开头、`super()` 之后。

### 步骤 5：字段初始化器

保持原位，留在类体里。降级不搬运字段初始化器，接受 F3 的顺序差异。

### 步骤 6：`new.target`

真正的 constructor 里 `new.target` 是准确的，写入槽位：

```js
const newTargetSym = Symbol.for('tspp.asyncConstructor.newTarget');

constructor(...) {
  super(...);
  this[newTargetSym] = new.target;
}
async [hiddenSym](key, ...args) {
  // 源码里的 new.target 改写为 this[newTargetSym]
}
```

### 步骤 7：改写调用点

用户代码里所有 async 类的 `new`：

```js
// 源码
const a = await new A(x, y);
const p = new A(x);            // 不 await
// 降级
const a = await createInstance(A, x, y);
const p = createInstance(A, x);
```

所有位置都照常改写，包括同步位置（静态块、字段初始化器、参数默认值、getter、同步回调内部）：
改写后得到的是 `Promise<A>`，不能 `await` 的地方就保持为 Promise，交给用户自己安排（第三节）。

识别不了的形态（`new this.constructor()`、`Reflect.construct`、跨包 `new`）写进已知限制。

### 步骤 8：生成声明

- 源码保留 `async constructor` 的类型；`new A(args)` 的类型为 `Promise<A>`。
- `hiddenSym` 在 `.d.ts` 中声明为导出的 `unique symbol`，避免 TS4094。
- `createInstance` 的签名：

```ts
declare function createInstance<T extends new (...args: any) => any>(
  cls: T,
  ...args: ConstructorParameters<T>
): Promise<InstanceType<T>>;
```

- 降级产物只输出 JS，不再对降级结果做第二次 TS 检查。

### 步骤 9：父类参数依赖 `await`（待定）

```ts
class MyMap extends Map {
  async constructor() {
    const entries = await load();
    await super(entries); // 参数依赖 await
  }
}
```

思路：给每个 async 类生成静态预取函数，工厂里先 await 出父类需要的参数，再 `Reflect.construct`。

```js
class MyMap extends Map {
  static async [preSym](args) { return [await load()]; }
  constructor(...a) { super(a.pop()); }
}
async function createMyMap(...args) {
  const superArgs = await MyMap[preSym](args);
  return Reflect.construct(MyMap, [...args, superArgs], MyMap);
}
```

静态预取可继承、可 `super` 组合（已验证）。尚未解决：

1. 父类有 rest 参数时，追加的槽位会被吞进 rest。
2. 工厂中多个 `await` 的相对顺序和依赖关系要完整复现。
3. 多层继承需要合并各级预取。
4. 父类构造 `return` 对象替换 `this` 时，后续初始化要作用在新 `this` 上。

---

## 六、待定缺陷

| 缺陷 | 内容 | 状态 |
|---|---|---|
| 缺陷1 | 父类构造函数参数依赖 `await`（步骤 9） | 待定，第一版可以先不支持 |
| 缺陷2 | mixin / 装饰器 / Proxy 包装类必须正确透传 `[hiddenSym]`，编译器无法校验 | 已知限制 |
| 缺陷3 | `new this.constructor()`、`Reflect.construct`、跨包 `new` 无法在编译期识别 | 已知限制 |

---

## 七、Case 对照

| case | 主题 | 结论 |
|---|---|---|
| 01 | 子类字段初始化顺序 | 接受偏差（F3） |
| 02 | 同步子类 | 禁止，必须写 async（F6） |
| 03 | 参数求值两次 | 已解决：占位形参（步骤 2） |
| 04 | TS 参数属性 | 已解决（步骤 4） |
| 05 | 多参数 `createInstance` | 已解决（步骤 1、7） |
| 06 | 裸 `new` | 用户误用（F2） |
| 07 | `callSym` 校验 | 编译器插入 key 校验（步骤 2） |
| 08 | 重复初始化 | 划掉：手动调用属逆天用法（F5） |
| 09 | init 失败后的脏对象 | 接受 |
| 10 | 父类参数依赖 await | **缺陷1（步骤 9，待定）** |
| 11 | 父类无 `[hiddenSym]` | 已解决：运行时 typeof 判断（步骤 1） |
| 12 | mixin / 装饰器 / Proxy | **缺陷2，已知限制** |
| 13 | 继承链在编译期不可知 | 已解决：存在 `[hiddenSym]` 即视作有；跨包父类必须同编译器产出 |
| 14 | `new.target` | 已解决：槽位还原（步骤 6） |
| 15 | 构造函数 `return` | 禁止（F1） |
| 16 | TS 严格检查 | 只输出 JS，不做二次检查（步骤 8） |
| 17 | `this` 提前逃逸 | 坏实践，不防（F4） |
| 18 | 调用点改写 | 编译器识别每个 `new`（步骤 7）；同步位置得到 Promise，见第三节 |
| 19 | symbol 跨副本 | 已解决：`Symbol.for`（步骤 1） |
| 20 | 反射可见性 | 语义差异 |
| 21 | `.d.ts` 与类型 | 已解决（步骤 8） |
| 22 | 栈信息 | 语义差异 |
| 23 | 性能 | 语义差异 |
| 24 | 静态块 / 类表达式 | 同步位置得到 Promise，见第三节；其余见缺陷3 |
