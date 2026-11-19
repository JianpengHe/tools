/**
 * 定义将JavaScript对象转换为TypeScript类型声明的选项接口
 */
export type IObjectToTypeScriptTypingOptions = {
  /**
   * 最大递归深度，防止循环引用导致的无限递归
   */
  maxDeep?: number;
};

/**
 * 将JavaScript对象转换为TypeScript类型声明的工具类
 * 通过分析对象的结构和值，自动生成对应的TypeScript类型定义
 */
export class ObjectToTypeScriptTyping {
  /** 配置选项 */
  private options: IObjectToTypeScriptTypingOptions;

  /**
   * 类型映射集合，用于存储所有检测到的类型
   * 可以存储基本类型字符串、对象类型或数组类型
   */
  private typeMap = new Set<string | { [x: string]: ObjectToTypeScriptTyping } | [ObjectToTypeScriptTyping]>();

  /**
   * 值频率统计映射，记录字符串、数字或布尔值出现的次数
   * 用于生成注释中的值分布信息
   */
  private valueCountMap = new Map<string, number>();

  /** 当前递归深度 */
  private deep = 0;

  /**
   * 构造函数
   * @param objects 要分析的对象数组
   * @param options 配置选项
   * @param deep 当前递归深度
   */
  constructor(objects: any[], options?: IObjectToTypeScriptTypingOptions, deep = 0) {
    if (deep > (options?.maxDeep ?? 50)) throw new Error("超过最大递归深度" + deep + "，请设置更大的maxDeep");
    this.deep = deep;
    this.options = options ?? {};
    this.buildType(objects, deep);
  }

  /**
   * 构建类型信息
   * 分析对象数组中的每个元素，确定其类型并添加到typeMap中
   * @param objects 要分析的对象数组
   * @param deep 当前递归深度
   */
  private buildType(objects: any[], deep: number) {
    const objectValues: object[] = [];
    for (const object of objects) {
      let type: string = typeof object;
      if (object === null) {
        // 处理null类型
        this.typeMap.add("null");
        continue;
      }
      if (type === "object") {
        // 获取对象的构造函数名称作为类型
        type = object?.constructor?.name ?? "object";
        if (type === "Object") {
          // 如果是普通对象，收集起来后续处理
          objectValues.push(object);
          continue;
        }
        this.typeMap.add(type);
        continue;
      }
      if (type === "function") {
        // 处理函数类型
        this.typeMap.add("Function");
        continue;
      }

      // 添加基本类型
      this.typeMap.add(type);

      /** 统计出现的频率 */
      if (type === "string" || type === "number" || type === "boolean") {
        // 截取前30个字符作为值的标识，并统计出现次数
        const value = String(object).substring(0, 30);
        this.valueCountMap.set(value, (this.valueCountMap.get(value) ?? 0) + 1);
      }
      continue;
    }

    // 处理收集到的普通对象
    if (objectValues.length > 0) {
      this.typeMap.add(this.buildObjectType(objectValues, deep));
    }

    // 特殊处理数组类型
    if (this.typeMap.has("Array")) {
      this.typeMap.delete("Array");
      // 创建数组元素类型的实例，提取所有数组的元素并平铺处理
      this.typeMap.add([
        new ObjectToTypeScriptTyping(objects.filter(object => Array.isArray(object)).flat(), this.options, deep + 1),
      ]);
    }
  }

  /**
   * 构建对象类型
   * 分析对象的属性结构，为每个属性创建对应的类型
   * @param objectValues 要分析的对象数组
   * @param deep 当前递归深度
   * @returns 包含属性名到类型映射的对象
   */
  private buildObjectType(objectValues: any, deep = 0) {
    // 收集所有对象的所有键
    const objectKeyMap = new Map<string, Array<object | undefined>>();
    for (const object of objectValues) {
      for (const key in object) objectKeyMap.set(key, []);
    }

    // 为每个键收集所有对象中对应的值
    for (const object of objectValues) {
      for (const [key, arr] of objectKeyMap) arr.push(object[key]);
    }

    // 为每个键创建类型定义，并按键名排序
    const output = Object.fromEntries(
      [...objectKeyMap.keys()]
        .sort()
        .map(key => [key, new ObjectToTypeScriptTyping(objectKeyMap.get(key)!, this.options, deep + 1)]),
    );
    // 特殊处理对象类型
    // 如果所有的key都是number类型的
    if (objectKeyMap.size > 0 && Object.keys(output).some(key => !isNaN(Number(key)))) {
      return {
        "[x: string]": new ObjectToTypeScriptTyping([...objectKeyMap.values()].flat(), this.options, deep + 1),
      };
    }

    return output;
  }

  /**
   * 转换为JSON时的处理方法
   * @returns 格式化后的类型字符串
   */
  public toJSON() {
    return this.format();
  }

  /**
   * 转换为字符串时的处理方法
   * @returns 格式化后的类型字符串
   */
  public toString() {
    return this.format();
  }

  /**
   * 生成注释信息
   * 基于值频率统计生成注释，显示最常见的值及其出现频率
   * @returns 注释字符串
   */
  private remark() {
    if (!this.valueCountMap.size) return "";
    // 计算所有值出现的总次数
    const total = [...this.valueCountMap.values()].reduce((a, b) => a + b, 0);
    // 按出现频率排序，取前5个最常见的值
    const str = [...this.valueCountMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(
        ([value, count]) =>
          value +
          // 如果所有值出现次数相同或只有一个值，不显示百分比
          (total === this.valueCountMap.size || count === total ? "" : `(${Math.round((count / total) * 100)}%)`),
      )
      .join(", ");
    return (str.includes("%") ? "出现频率：" : "") + str;
  }

  /**
   * 格式化类型定义为TypeScript类型声明字符串
   * @param key 属性名（可选）
   * @returns 格式化后的类型字符串
   */
  public format(key?: string) {
    // 将所有类型转换为字符串表示
    const typeStr = new Set(
      [...this.typeMap].map(type => {
        if (typeof type === "string") return type.trim();
        if (Array.isArray(type)) return (type[0].typeMap.size > 1 ? `(${type[0].format()})` : type[0].format()) + "[]";
        return (
          "{\n" +
          Object.entries(type)
            .map(([key, value]) => value.format(key) + ";\n")
            .join("") +
          this.formatTab() +
          "}"
        );
      }),
    );

    // 生成注释信息
    const remark = key ? this.remark() : "";
    let output = "";
    if (remark) output += `${this.formatTab()}/** ${remark} */\n`;

    // 处理属性名和可选性
    if (key) {
      output += this.formatTab() + key;
      // 如果类型包含undefined且不止一种类型，将属性标记为可选
      if (typeStr.has("undefined") && typeStr.size > 1) {
        typeStr.delete("undefined");
        if (key !== "[x: string]") output += "?";
      }
      output += ": ";
    }

    // 合并所有类型，使用联合类型表示
    output += [...typeStr].sort().join(" | ");
    return output.replace(/\{\n\s*\}/g, "{}"); //.replace(/:\s\[\];/g, ": any[];");
  }

  /**
   * 生成缩进空格
   * @param add 额外的缩进级别
   * @returns 缩进字符串
   */
  private formatTab(add = 0) {
    return "  ".repeat(this.deep + add);
  }
}

/** 使用例子 */
// console.log(String(new ObjectToTypeScriptTyping([{ 1: { name: "1" }, 2: { name: "2" }, 3: { name: "3" } }])));
