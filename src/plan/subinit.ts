/**
 * 给类增加async constructor的提案
 * 案例代码在example.ts中
 *
 * 以下是降级编译方案
 * 1. 创建两个symbol，一个用于标记异步构造函数，一个用于调用验证
 * 2. 将constructor内部的逻辑移动到这个[Symbol.asyncConstructor]方法中
 * 3. 使用createInstance函数来创建实例，确保异步构造函数被正确调用
 *    createInstance函数是公用的
 */
declare global {
  interface SymbolConstructor {
    readonly asyncConstructor: unique symbol;
  }
}
const callSym = Symbol();

async function createInstance(cls: any, args: any) {
  const inst = new cls(args);
  await inst[Symbol.asyncConstructor](callSym, args);
  return inst;
}

class A {
  #data: any;
  constructor(args: any) {}
  async [Symbol.asyncConstructor](key: symbol, args: any) {
    this.#data = await fetch('/test', args)
      .then((res) => res.json())
      .catch(() => null);
  }
}

// const a = await new A({});
const a = await createInstance(A, {});
