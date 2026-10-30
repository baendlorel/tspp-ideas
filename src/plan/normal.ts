/**
 * 这是异步构造函数的示例，肯定需要降级。
 * 
 * 已确定的正常现象：
 * 1. 如果没有await new A，只有new A，得到的是Promise。行为和Promise一模一样，instanceof等操作也是
 * 2. 这意味着一些只允许sync代码的地方，没办法立刻获得A的实例
 * 3. 传染性，子类必然也是异步构造的，不写async会报错
 */

class A {
  #data: any;
  // @ts-expect-error
  async constructor(args: any) {
      // @ts-expect-error
      this.#data = await fetch('/test',args).then(res => res.json()).catch(() => null);
  }
}
const a = await new A({});


class ASub extends A{
   #subdata:any;
   // @ts-expect-error
   async constructor(args: any) {
       // @ts-expect-error
       await super(args);
       this.#subdata = 3;
   }
}

const asub = await new ASub({})