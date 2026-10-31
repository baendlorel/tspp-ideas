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

按处理顺序分四个阶段：**分析 → 改写类 → 改写调用点 → 产出**。
后面的步骤依赖前面的判定结果，尤其是步骤 2 的「构造路径」。
「父类是同步类、`super` 的参数依赖 `await`」不是最后补的特例，而是步骤 2 分流出来的路径 B，
它的产物在步骤 6 生成，运行时分支在步骤 8 的 `createInstance` 里。

| 阶段 | 步骤 |
|---|---|
| 一、分析 | 1 识别与校验 → 2 选择构造路径 |
| 二、改写类 | 3 拆分构造函数体 → 4 生成 `[hiddenSym]`（路径 A）→ 5 生成真正的 constructor（路径 A）→ 6 路径 B 的产物 |
| 三、改写调用点 | 7 `new` → `createInstance` |
| 四、产出 | 8 注入运行时 → 9 生成声明 |

### 阶段一：分析

#### 步骤 1：识别与校验

- 标记所有带 `async constructor` 的类（下称 async 类）。
- 校验：子类是否也写了 `async constructor`（F6）；构造函数是否 `return` 非 undefined（F1）。
- 收集所有 `new` async 类的位置，**包括同步位置**（不报错，见第三节），留给步骤 7。
- 把 async 类按「父类先于子类」排序。子类走哪条路径取决于父类，所以后面的阶段按这个顺序处理。

#### 步骤 2：为每个 async 类选择构造路径

问题的根源是：派生类的真正 constructor 必须**同步**调用 `super(...)`。
父类是 async 类（SubInit 产物）时，它的真正 constructor 是空的，`super()` 不需要任何实参，没有问题。
父类是同步类（`Map`、`Error`、`HTMLElement`、第三方类、普通类）时，`super` 的实参要在 constructor 里同步给出，
而源码里这些实参可能依赖 `await`。所以按下表分流：

| 条件 | 路径 |
|---|---|
| 无 `extends`，或父类是走路径 A 的 async 类 | **A（标准）** |
| 父类是同步类，且 `super` 之前没有语句，`await super(...)` 的实参只是对「无默认值、无解构的普通形参」的直接转发（含 `super()`） | **A**，真正的 constructor 直接 `super(a, b)` |
| 父类是同步类，其余情况：`super` 之前有语句，或实参含 `await` / 表达式 / 带默认值或解构的形参 | **B（预取）** |
| 父类是走路径 B 的 async 类，且子类显式写了 `async constructor` | **B**（沿继承链向下传染） |

说明：

- 判断父类是不是 async 类，依据同一编译单元里的声明，或 `.d.ts` 里的 async 标记。
  查不到标记的跨包父类按同步类处理（见缺陷4）。
- 路径 B 的整体设计还有一块未定（见缺陷1）。第一版如果不做，上表第三、四行直接编译报错即可。

### 阶段二：改写类

#### 步骤 3：以 `super` 为界拆分构造函数体

```ts
async constructor(<params>) {
  <pre>                  // super 之前的语句
  await super(<superArgs>);
  <post>                 // super 之后的语句
}
```

无 `extends` 时全部算 `post`。

`pre` 不能访问 `this`，也不能写 `super.x`，这是语言规则（实测两者都是 `ReferenceError`）。
所以 `pre` 可以原样搬到别的函数里，不需要改写对 `this` 的引用。

#### 步骤 4：生成 `[hiddenSym]`（路径 A）

- 签名 `async [hiddenSym](key, <原参数列表>)`：原参数列表（默认值、解构、rest 都保留）原样跟在 `key` 后面，
  参数只在这里解析一次。源码里的 `arguments` 改写成去掉 `key` 的视图。
- 函数体顺序：

  ```
  key 校验 → pre → await super[hiddenSym](key, ...superArgs) → 参数属性赋值 → post
  ```

  - 第一句固定是 `if (key !== callSym) throw new Error('Invalid call to hiddenSym');`。
  - `super[hiddenSym]` 的实参取自源码里 `await super(...)` 的实参，不是子类自己的参数。
  - 父类是同步类（步骤 2 第二行）时，`super(...)` 已在真正的 constructor 里完成，这里没有 `pre`，也没有 `super[hiddenSym]` 调用。
  - 无 `extends` 时没有 `pre` 和 `super` 调用，参数属性赋值排在 `key` 校验之后。
  - TS 参数属性 `constructor(private x)` 降级为 `this.x = x`，位置在 `super` 之后，与 TS 处理普通参数属性一致。
- 源码里的 `new.target` 改写为 `this[newTargetSym]`（槽位由步骤 5 写入）。
- 隐式构造函数的子类不生成任何成员，直接继承父类的 `[hiddenSym]`。

#### 步骤 5：生成真正的 constructor（路径 A）

- 形参：占位 `_0`, `_1`…，个数取原 constructor 的 `length`（第一个默认值或 rest 之前的参数个数）。
  占位形参没有默认值和解构，所以不会产生副作用，`Class.length` 也与源码一致。
  步骤 2 第二行的情况例外：被转发给 `super` 的形参保留原名。
- 函数体：
  - 父类是 async 类 → `super()`。
  - 父类是同步类（步骤 2 第二行）→ `super(a, b)`。
  - 源码用到 `new.target` 时，在 `super` 之后写 `this[newTargetSym] = new.target`。
- 字段初始化器保持原位，留在类体里，接受 F3 的顺序差异。

示例（路径 A，步骤 4、5 合起来的结果）：

```ts
// 源码
class A {
  #data;
  async constructor(url, opts = {}) { this.#data = await load(url, opts); }
}
class ASub extends A {
  #sub;
  async constructor(url, private readonly tag: string) {
    await super(url);
    this.#sub = 3;
  }
}
```

```js
// 降级
class A {
  #data;
  constructor(_0) {}                        // length = 1：opts 有默认值，不计
  async [hiddenSym](key, url, opts = {}) {
    if (key !== callSym) throw new Error('Invalid call to hiddenSym');
    this.#data = await load(url, opts);
  }
}
class ASub extends A {
  #sub;
  constructor(_0, _1) { super(); }
  async [hiddenSym](key, url, tag) {
    if (key !== callSym) throw new Error('Invalid call to hiddenSym');
    await super[hiddenSym](key, url);       // 实参取自 super(url)
    this.tag = tag;                         // 参数属性，在 super 之后
    this.#sub = 3;
  }
}
```

#### 步骤 6：路径 B 的产物（待定）

适用：步骤 2 判为 B 的类。典型情形是父类参数依赖 `await`：

```ts
// 源码
class MyMap extends Map {
  async constructor(name) {
    const entries = await load();                // pre
    await super(entries);                        // 同步父类，实参依赖 await
    this.label = `${name}:${entries.length}`;    // post，用到了 pre 里的局部变量
  }
}
```

路径 B 为每个类生成三样东西，把「需要 await 才能得到的值」全部放到构造之前算好：

1. **预取函数** `static async [preSym](<原参数列表>)`：函数体是 `pre` 加上对 `super` 实参的求值，
   返回 `{ superArgs, ctx }`。`ctx` 装 `post` 还要用到的东西：已解析的形参、`pre` 里声明的局部变量。
2. **真正的 constructor** `constructor(pre)`：`super(...pre.superArgs)`。`pre` 固定放在第一个形参。
3. **`[hiddenSym](key, ctx)`**：只含 `post`（外加 key 校验、参数属性赋值），变量从 `ctx` 里解构。

```js
// 降级
class MyMap extends Map {
  static async [preSym](name) {
    const entries = await load();
    return { superArgs: [entries], ctx: { name, entries } };
  }
  constructor(pre) { super(...pre.superArgs); }
  async [hiddenSym](key, { name, entries }) {
    if (key !== callSym) throw new Error('Invalid call to hiddenSym');
    this.label = `${name}:${entries.length}`;
  }
}
```

设计依据：

- `pre` 整体搬进预取函数，语句顺序不变，`await` 的相对顺序和依赖关系自然保持。`pre` 不能碰 `this`（步骤 3），不需要改写。
- 预取函数拿到的是完整的原参数列表，形参在这里解析一次，解析结果通过 `ctx` 交给 `[hiddenSym]`，所以参数不会被求值两次。
- `pre` 放在第一个形参的固定位置，由编译器生成的 constructor 自己展开 `superArgs`。
  不追加在原参数后面，所以不会被原参数的 rest 或父类的 rest 吞掉。
- 预取函数里的 `new.target` 改写为 `this`（通过 `cls[preSym](...)` 调用，`this` 就是被构造的类）。
  `post` 里的 `new.target` 仍用步骤 5 的槽位，路径 B 的 constructor 同样写入。
- 隐式构造函数的子类直接继承 `[preSym]`、constructor 和 `[hiddenSym]`，已用原型验证可行（`size`、`label`、`instanceof` 都正确）。

未解决的只有一块，见缺陷1：显式写了 `async constructor` 的子类继承路径 B 的类时，预取与 `ctx` 的分层传递。

### 阶段三：改写调用点

#### 步骤 7：`new` → `createInstance`

用户代码里所有 async 类的 `new`：

```js
// 源码
const a = await new A(x, y);
const p = new A(x);            // 不 await
// 降级
const a = await createInstance(A, x, y);
const p = createInstance(A, x);
```

- 路径 A、B 的调用点写法完全一样，分流发生在 `createInstance` 内部（步骤 8），调用点不需要知道类走哪条路径。
- 所有位置都照常改写，包括同步位置（静态块、字段初始化器、参数默认值、getter、同步回调内部）：
  改写后得到的是 `Promise<A>`，不能 `await` 的地方就保持为 Promise，交给用户自己安排（第三节）。
- 识别不了的形态（`new this.constructor()`、`Reflect.construct`、跨包 `new`）写进已知限制（缺陷3）。

### 阶段四：产出

#### 步骤 8：注入运行时

在模块顶部注入 symbol 与工厂：

```js
const hiddenSym    = Symbol.for('tspp.asyncConstructor');
const callSym      = Symbol.for('tspp.asyncConstructor.call');
const newTargetSym = Symbol.for('tspp.asyncConstructor.newTarget');
const preSym       = Symbol.for('tspp.asyncConstructor.prefetch');  // 仅路径 B 使用

async function createInstance(cls, ...args) {
  let inst, initArgs;
  if (typeof cls[preSym] === 'function') {      // 路径 B：先预取，再构造
    const pre = await cls[preSym](...args);
    inst = new cls(pre);
    initArgs = [pre.ctx];
  } else {                                      // 路径 A
    inst = new cls(...args);
    initArgs = args;
  }
  const init = cls.prototype[hiddenSym];        // 不写 inst[hiddenSym]，原因见下
  if (typeof init === 'function') await init.call(inst, callSym, ...initArgs);
  return inst;
}
```

- `Symbol.for` 保证多份 bundle / 多个运行时实例看到同一个符号。
- 用 `cls.prototype[hiddenSym]` 而不是 `inst[hiddenSym]`：同步父类的 constructor 如果 `return` 了另一个对象，
  `new` 的结果不在 `cls` 的原型链上，`inst[hiddenSym]` 是 `undefined`，异步初始化会被静默跳过（已验证）。
  改用原型上的函数 `.call(inst, ...)` 可以正常初始化那个对象（已验证）。
- `typeof init === 'function'` 是兜底：类没有异步部分时直接返回实例，不报错。
- 模块里没有路径 B 的类时，可以省掉预取分支和 `preSym`。

#### 步骤 9：生成声明

- 源码保留 `async constructor` 的类型；`new A(args)` 的类型为 `Promise<A>`。
- `hiddenSym` 在 `.d.ts` 中声明为导出的 `unique symbol`，避免 TS4094。
- 对外标记哪些类是 async 类，供其他包的子类在步骤 2 判断父类（缺陷4）。
- `createInstance` 的签名：

```ts
declare function createInstance<T extends new (...args: any) => any>(
  cls: T,
  ...args: ConstructorParameters<T>
): Promise<InstanceType<T>>;
```

- 降级产物只输出 JS，不再对降级结果做第二次 TS 检查。

---

## 六、待定缺陷

| 缺陷 | 内容 | 状态 |
|---|---|---|
| 缺陷1 | 路径 B 在多层继承下的分层传递：显式 `async constructor` 的子类继承路径 B 的类时，子类的 `pre` 先执行、得到给父类的实参，再 `await super[preSym](...)` 取父类的预取结果。静态方法可以用 `super` 组合（已验证），但返回结构（每层一份 `ctx`、真正的 constructor 链如何逐层取 `superArgs`、每层的 `[hiddenSym]` 拿哪份 `ctx`）还没设计 | 待定，第一版可以先不支持（步骤 2 第四行报错） |
| 缺陷2 | mixin / 装饰器 / Proxy 包装类必须正确透传 `[hiddenSym]`，编译器无法校验 | 已知限制 |
| 缺陷3 | `new this.constructor()`、`Reflect.construct`、跨包 `new` 无法在编译期识别 | 已知限制 |
| 缺陷4 | 查不到 async 标记的跨包父类被当成同步类，如果它实际是 async 类，异步初始化会被静默跳过。跨包 async 父类必须由同一编译器产出并带 `.d.ts` 标记 | 已知限制 |

---

## 七、Case 对照

| case | 主题 | 结论 |
|---|---|---|
| 01 | 子类字段初始化顺序 | 接受偏差（F3） |
| 02 | 同步子类 | 禁止，必须写 async（F6） |
| 03 | 参数求值两次 | 已解决：占位形参 + 参数只在 `[hiddenSym]` 解析（步骤 4、5） |
| 04 | TS 参数属性 | 已解决（步骤 4） |
| 05 | 多参数 `createInstance` | 已解决（步骤 4、8） |
| 06 | 裸 `new` | 用户误用（F2） |
| 07 | `callSym` 校验 | 编译器插入 key 校验（步骤 4） |
| 08 | 重复初始化 | 划掉：手动调用属逆天用法（F5） |
| 09 | init 失败后的脏对象 | 接受 |
| 10 | 父类参数依赖 await | 路径 B（步骤 2、6）；多层继承见 **缺陷1，待定** |
| 11 | 父类无 `[hiddenSym]` | 已解决：运行时 typeof 判断（步骤 8） |
| 12 | mixin / 装饰器 / Proxy | **缺陷2，已知限制** |
| 13 | 继承链在编译期不可知 | 已解决：步骤 2 按声明 / `.d.ts` 标记判断；无标记的跨包父类见缺陷4 |
| 14 | `new.target` | 已解决：槽位还原（步骤 4、5、6） |
| 15 | 构造函数 `return` | 禁止（F1） |
| 16 | TS 严格检查 | 只输出 JS，不做二次检查（步骤 9） |
| 17 | `this` 提前逃逸 | 坏实践，不防（F4） |
| 18 | 调用点改写 | 编译器识别每个 `new`（步骤 7）；同步位置得到 Promise，见第三节 |
| 19 | symbol 跨副本 | 已解决：`Symbol.for`（步骤 8） |
| 20 | 反射可见性 | 语义差异 |
| 21 | `.d.ts` 与类型 | 已解决（步骤 9） |
| 22 | 栈信息 | 语义差异 |
| 23 | 性能 | 语义差异 |
| 24 | 静态块 / 类表达式 | 同步位置得到 Promise，见第三节；其余见缺陷3 |
