class A {
  data: any;
  // @ts-expect-error
  async constructor(args: any) {
      // @ts-expect-error
      this.data = await fetch('/test',args).then(res => res.json()).catch(() => null);
  }
}
const a = await new A({});


class ASub extends A{
   subdata:any;
   // @ts-expect-error
   async constructor(args: any) {
       // @ts-expect-error
       await super(args);
       this.subdata = 3;
   }
}

const asub = await new ASub({})