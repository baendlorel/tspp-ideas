/**
 * 给类增加async constructor的提案
 * 案例代码在example.ts中
 *
 * 以下是降级编译方案，名为Throw法。
 * 1. 将async constructor的入参、函数体提取出来，放到一个新函数async function constructA中.
 *    如果有super的调用，那么就将父类生成的constructParent函数放到对应位置并且.call(this,...args)
 * 2. 原来的构造函数去掉constructor的async标记，函数体改为3个步骤
 *    1、让const raw = constructA.call(this, args).then(() => this);
 *    2、将raw加入globalContainer
 *    3、抛出raw
 * 3. b的构造过程是
 *    1、let a
 *    2、try new A({})，捕获异常
 *    3、如果异常在globalContainer中，await异常并赋值给a
 *    4、否则抛出异常
 */

// 以下是结果
const globalContainer = new WeakSet();
function constructAsync(cls: any, args: any[]) {
  try {
    new cls(...args);
  } catch (e) {
    if (globalContainer.has(e as any)) {
      return e;
    } else {
      throw e;
    }
  }
}

async function constructA(this: any, args: any) {
  this.data = await fetch('/test', args)
    .then((res) => res.json())
    .catch(() => null);
}
class A {
  constructor(args: any) {
    const raw = constructA.call(this, args).then(() => this);
    globalContainer.add(raw);
    throw raw;
  }
}
let b = await constructAsync(A, [{}]);

async function constructASub(this: any, args: any) {
  await constructA.call(this, args);
  this.subdata = 3;
}
class ASub {
  constructor(args: any) {
    const raw = constructASub.call(this, args).then(() => this);
    globalContainer.add(raw);
    throw raw;
  }
}
let bsub = await constructAsync(ASub, [{}]);
