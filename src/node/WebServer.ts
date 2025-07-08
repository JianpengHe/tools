/** 轻量级 Web 服务器实现 */
import * as http from "http";
import { JWT } from "./JWT";

/** 任意键值对类型 */
type RecordAny = Record<string, any>;
/** 字符串键值对类型 */
type RecordString = Record<string, string | string[]>;

/** 服务器类型定义 */
namespace WebServerType {
  /** 增强版 URLSearchParams */
  export interface URLSearchParamsPlus<T extends RecordString> extends URLSearchParams {
    get(key: keyof T): string;
    getAll(key: keyof T): string[];
    append(key: keyof T, value: string): void;
    set(key: keyof T, value: string): void;
    delete(key: keyof T): void;
  }
  type ExtractSearchParams<Obj> = Obj extends { searchParams?: infer S } ? (S extends RecordString ? S : {}) : {};
  type ExtractReqBody<Obj> = Obj extends { reqBody?: infer S } ? (S extends RecordAny ? S : {}) : {};
  type ExtractResBody<Obj> = Obj extends { resBody?: infer S } ? (S extends RecordAny ? S : void) : void;

  /** HTTP方法处理器工厂 */
  export type MethodHandler<
    T extends IWebServerApi,
    Method extends keyof IWebServerApi,
    Cookies extends RecordString,
    JWTPayload extends RecordAny
  > = <
    Route extends T[Method] extends undefined ? never : T[Method],
    Path extends keyof Route,
    Obj extends Route[Path]
  >(
    pathName: Path,
    callback: (
      params: IWebServerRequest<ExtractSearchParams<Obj>, ExtractReqBody<Obj>, Cookies, JWTPayload>
    ) => Promise<ExtractResBody<Obj>>
  ) => void;
}

/** Web服务器API接口定义 */
export type IWebServerApi = {
  /** GET方法 - 获取资源 */
  get?: Record<string, { searchParams?: RecordString; resBody?: RecordAny }>;
  /** POST方法 - 创建资源 */
  post?: Record<string, { searchParams?: RecordString; reqBody?: RecordAny; resBody?: RecordAny }>;
  /** PUT方法 - 完整更新资源 */
  put?: Record<string, { searchParams?: RecordString; reqBody?: RecordAny; resBody?: RecordAny }>;
  /** DELETE方法 - 删除资源 */
  delete?: Record<string, { searchParams?: RecordString; resBody?: RecordAny }>;
  /** PATCH方法 - 部分更新资源 */
  patch?: Record<string, { searchParams?: RecordString; reqBody?: RecordAny; resBody?: RecordAny }>;
  /** HEAD方法 - 获取资源头信息 */
  head?: Record<string, { searchParams?: RecordString; resBody?: RecordAny }>;
};

/** 请求对象接口 */
export type IWebServerRequest<
  SearchParams extends RecordString,
  ReqBody extends RecordAny,
  Cookies extends RecordString,
  JWTPayload extends RecordAny
> = {
  /** Cookie参数 */
  cookies: WebServerType.URLSearchParamsPlus<Cookies>;
  /** 查询参数 */
  searchParams: WebServerType.URLSearchParamsPlus<SearchParams>;
  /** 解析后的请求体 */
  reqBody: ReqBody;
  /** 原始请求体缓冲区 */
  reqBodyBuffer: Buffer;
  /** 原始 HTTP 请求对象 */
  request: http.IncomingMessage;
  /** 原始 HTTP 响应对象 */
  response: http.ServerResponse;
  /** 临时数据存储 */
  tempData: any;
  /** JWT载荷数据(如果已验证) */
  jwt?: ReturnType<JWT<JWTPayload>["parse"]>["payload"];
  /** 设置JWT令牌 */
  setJWT: (jwtPayload: ReturnType<JWT<JWTPayload>["parse"]>["payload"]) => void;
  /** 设置Cookie */
  setCookie: <T extends keyof Cookies>(
    key: T,
    value: Cookies[T],
    maxAge?: number,
    domain?: string,
    path?: string,
    httpOnly?: boolean,
    secure?: boolean,
    sameSite?: "strict" | "lax" | "none"
  ) => void;
};
/** 服务器配置选项 */
export type IWebServerProps<JWTPayload extends RecordAny> = {
  /** 路由前缀路径 */
  prefixPath?: string;
  /** JWT实例 */
  jwt?: JWT<JWTPayload>;
  /** 最大请求体大小 */
  maxContentLength?: number;
};
/** Web服务器类 */
export class WebServer<T extends IWebServerApi, Cookies extends RecordString = {}, JWTPayload extends RecordAny = {}> {
  /** 路由前缀路径 */
  public readonly prefixPath: string = "";
  /** JWT实例 */
  public readonly jwt?: JWT<JWTPayload>;
  /** 最大请求体大小 */
  public readonly maxContentLength: number;

  /** 路由映射表 */
  private readonly routeMap = new Map<string, Array<(params: any) => Promise<any>>>();

  /** 前置中间件 */
  public readonly beforeRouteCallbacks: Array<
    (params: IWebServerRequest<any, any, Cookies, JWTPayload>) => Promise<any>
  > = [];
  /** 后置中间件 */
  public readonly afterRouteCallbacks: Array<
    (params: IWebServerRequest<any, any, Cookies, JWTPayload>, returnValue: any) => Promise<any>
  > = [];

  /** 构造函数 */
  constructor(props: IWebServerProps<JWTPayload>) {
    this.prefixPath = props.prefixPath || "";
    this.jwt = props.jwt;
    // 默认最大请求体大小为 10MB
    this.maxContentLength = props.maxContentLength || 10 * 1024 * 1024;
  }

  /** 处理HTTP请求入口 */
  public onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<any> | false {
    const routeKey = `${request.method} ${request.url}`;
    const callbacks = this.routeMap.get(routeKey);
    return callbacks ? this.resolveRequest(callbacks, request, response) : false;
  }

  /** 解析并处理请求 */
  private async resolveRequest(
    callbacks: Array<(params: any) => Promise<any>>,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ) {
    let responseData: any = undefined;
    const self = this;
    const requestContext: IWebServerRequest<any, any, Cookies, JWTPayload> = {
      get cookies() {
        return new URLSearchParams(request.headers?.["cookie"]?.replace(/; /g, "&")) as any;
      },
      get searchParams() {
        return new URL(request.url || "", `http://${request.headers.host}`).searchParams as any;
      },

      get reqBody() {
        try {
          if (request.headers["content-type"]?.includes("application/json"))
            return JSON.parse(String(requestContext.reqBodyBuffer));
        } catch (e) {}
        return {};
      },
      request,
      response,
      reqBodyBuffer: Buffer.allocUnsafe(0),
      tempData: {},
      /** 设置JWT令牌 */
      setJWT(jwtPayload) {
        if (!self.jwt) throw new Error("未设置JWT");
        const jwtToken: any = "Bearer " + self.jwt.stringify(jwtPayload);
        response.setHeader("authorization", jwtToken);
        requestContext.setCookie("authorization", jwtToken, self.jwt.expirationTime);
      },
      /** 设置Cookie */
      setCookie(key, value, maxAge, domain, path, httpOnly, secure, sameSite) {
        let cookieStr = `${String(key)}=${encodeURIComponent(String(value))}; Path=${path || "/"}; `;
        if (maxAge) cookieStr += `Max-Age=${maxAge}; `;
        if (domain) cookieStr += `Domain=${domain}; `;
        if (httpOnly) cookieStr += `HttpOnly; `;
        if (secure) cookieStr += `Secure; `;
        if (sameSite) cookieStr += `SameSite=${sameSite}; `;
        response.appendHeader("set-cookie", cookieStr);
      },
    };
    try {
      /** 处理请求体 */
      let contentLength = Number(request.headers["content-length"] || 0);
      if (contentLength) {
        if (contentLength > this.maxContentLength) {
          response.statusCode = 413;
          throw new Error("请求体过大");
        }
        const bodyChunks: Buffer[] = [];
        for await (let chunk of request) {
          if (chunk.length > contentLength) chunk = chunk.subarray(0, contentLength);
          bodyChunks.push(chunk);
          contentLength -= chunk.length;
          if (contentLength <= 0) break;
        }
        requestContext.reqBodyBuffer = Buffer.concat(bodyChunks);
      }

      /** 验证JWT令牌 */
      if (this.jwt) {
        const authToken =
          (requestContext.cookies.get("authorization") || request.headers?.["authorization"])
            ?.toString()
            ?.replace("Bearer ", "") || "";
        if (authToken) {
          const jwtData = this.jwt.parse(authToken);
          if (jwtData && this.jwt.verify(jwtData)) requestContext.jwt = jwtData.payload;
        }
      }

      /** 执行路由处理链 */
      for (const callback of this.beforeRouteCallbacks) responseData = await callback(requestContext);
      for (const callback of callbacks) responseData = await callback(requestContext);
      for (const callback of this.afterRouteCallbacks) responseData = await callback(requestContext, responseData);

      /** 格式化响应数据 */
      response.setHeader("Content-Type", "application/json;charset=utf-8");
      responseData = typeof responseData === "object" ? JSON.stringify(responseData) : String(responseData);
    } catch (e: any) {
      /** 异常处理 */
      response.setHeader("Content-Type", "text/plain;charset=utf-8");
      responseData = String(e?.message ?? e);
      if (!response.statusCode || response.statusCode < 400) response.statusCode = 422;
    }
    response.end(responseData);
    return responseData;
  }

  /** GET方法路由处理器 */
  public get: WebServerType.MethodHandler<T, "get", Cookies, JWTPayload> = (pathName, callback) =>
    this.addRoute("GET", pathName, callback);
  /** POST方法路由处理器 */
  public post: WebServerType.MethodHandler<T, "post", Cookies, JWTPayload> = (pathName, callback) =>
    this.addRoute("POST", pathName, callback);
  /** PUT方法路由处理器 */
  public put: WebServerType.MethodHandler<T, "put", Cookies, JWTPayload> = (pathName, callback) =>
    this.addRoute("PUT", pathName, callback);
  /** DELETE方法路由处理器 */
  public delete: WebServerType.MethodHandler<T, "delete", Cookies, JWTPayload> = (pathName, callback) =>
    this.addRoute("DELETE", pathName, callback);
  /** PATCH方法路由处理器 */
  public patch: WebServerType.MethodHandler<T, "patch", Cookies, JWTPayload> = (pathName, callback) =>
    this.addRoute("PATCH", pathName, callback);
  /** HEAD方法路由处理器 */
  public head: WebServerType.MethodHandler<T, "head", Cookies, JWTPayload> = (pathName, callback) =>
    this.addRoute("HEAD", pathName, callback);

  /** 添加路由处理器 */
  private addRoute(
    method: string,
    pathName: any,
    callback: (params: IWebServerRequest<any, any, any, any>) => Promise<any>
  ) {
    const routeKey = `${method} /${this.prefixPath}${pathName}`;
    const handlers = this.routeMap.get(routeKey) || [];
    handlers.push(callback);
    this.routeMap.set(routeKey, handlers);
  }
}

/** 测试用例 */
// interface API extends IWebServerApi {
//   get: {
//     checkLogin: {
//       searchParams: { type: string };
//       resBody: { type: string; user: string; userId: number };
//     };
//   };
//   post: {
//     login: {
//       reqBody: { user: string; pwd: string };
//       resBody: { success: boolean };
//     };
//   };
// }

// type Cookies = {
//   authorization: string;
// };

// type JWTPayload = {
//   userId: number;
//   user: string;
// };

// const webServer = new WebServer<API, Cookies, JWTPayload>({ jwt: new JWT(20 * 60) });

// webServer.post("login", async ({ reqBody, setJWT }) => {
//   if (reqBody.user !== "admin" || reqBody.pwd !== "123456") throw new Error("账号密码不正确");
//   setJWT({ userId: 666, user: reqBody.user });
//   return { success: true };
// });

// webServer.get("checkLogin", async ({ searchParams, jwt, cookies }) => {
//   if (!jwt?.userId) throw new Error("未登录");
//   console.log("cookies", cookies.get("authorization"));
//   return { type: searchParams.get("type"), user: jwt.user, userId: jwt.userId };
// });

// http
//   .createServer(async (request, response) => {
//     const res = webServer.onRequest(request, response);
//     if (res === false) response.end("404");
//   })
//   .listen(80);
