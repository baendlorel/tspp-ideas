/**
 * 给类增加async constructor的提案
 * 案例代码在example.ts中
 *
 * 以下是降级编译方案，名为SubInit法
 * 1. 创建两个symbol，一个用于标记异步构造函数，一个用于调用验证
 * 2. 将constructor内部的逻辑移动到这个[hiddenSym]方法中
 *    这样一来其实构造函数是空的
 *    对于子类，则将super调用放在constructor中，实际父类构造函数是空的
 *    子类原本的构造函数体，则迁移到[hiddenSym]方法中，其中对super的调用改为对super[hiddenSym]的调用，相应的async await保留。
 * 3. 使用createInstance函数来创建实例，确保异步构造函数被正确调用
 *    createInstance函数是公用的
 *
 * 降级后的例子如下
 */
const hiddenSym = Symbol();
const callSym = Symbol();

async function createInstance(cls: any, ...args: any[]) {
  const inst = new cls(...args);
  await inst[hiddenSym](callSym, ...args);
  return inst;
}

class A {
  #data: any;
  constructor(args: any) {}

  // 这里会被Reflect.ownKeys遍历出来，但没关系，可以接受
  async [hiddenSym](key: symbol, args: any) {
    if (key !== callSym) throw new Error('Invalid call to hiddenSym');
    this.#data = await fetch('/test', args)
      .then((res) => res.json())
      .catch(() => null);
  }
}

// const a = await new A({});
const a = await createInstance(A, {});

class ASub extends A {
  #subdata: any;
  constructor(args: any) {
    //  await super(args);
    super(args); // 实际上父类构造函数是空的
  }

  override async [hiddenSym](key: symbol, args: any) {
    if (key !== callSym) throw new Error('Invalid call to hiddenSym');
    await super[hiddenSym](key, args);
    this.#subdata = 3;
  }
}

const asub = await createInstance(ASub, {});
