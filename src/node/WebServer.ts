import * as http from "http";
import { JWT } from "./JWT";

type RecordAny = Record<string, any>;
type RecordString = Record<string, string | string[]>;

namespace WebServerType {
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

  /** 定义一个 泛型工厂 */
  export type MethodHandler<
    T extends IWebServerApi,
    Method extends keyof IWebServerApi,
    Cookies extends RecordString,
    JWTPayload extends RecordAny,
  > = <
    Route extends T[Method] extends undefined ? never : T[Method],
    Path extends keyof Route,
    Obj extends Route[Path],
  >(
    pathname: Path,
    callback: (
      params: IWebServerRequest<ExtractSearchParams<Obj>, ExtractReqBody<Obj>, Cookies, JWTPayload>,
    ) => Promise<ExtractResBody<Obj>>,
  ) => void;
}

export type IWebServerApi = {
  /** 获取 */
  get?: Record<string, { searchParams?: RecordString; resBody?: RecordAny }>;
  /** 创建 */
  post?: Record<string, { searchParams?: RecordString; reqBody?: RecordAny; resBody?: RecordAny }>;
  /** 更新 */
  put?: Record<string, { searchParams?: RecordString; reqBody?: RecordAny; resBody?: RecordAny }>;
  /** 删除 */
  delete?: Record<string, { searchParams?: RecordString; resBody?: RecordAny }>;
  /** 部分更新 */
  patch?: Record<string, { searchParams?: RecordString; reqBody?: RecordAny; resBody?: RecordAny }>;
  /** 头 */
  head?: Record<string, { searchParams?: RecordString; resBody?: RecordAny }>;
};

export type IWebServerRequest<
  SearchParams extends RecordString,
  ReqBody extends RecordAny,
  Cookies extends RecordString,
  JWTPayload extends RecordAny,
> = {
  cookies: WebServerType.URLSearchParamsPlus<Cookies>;
  searchParams: WebServerType.URLSearchParamsPlus<SearchParams>;
  reqBody: ReqBody;
  reqBodyBuffer: Buffer;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  tempData: any;
  jwt?: ReturnType<JWT<JWTPayload>["parse"]>["payload"];
  setJWT: (jwtPayload: ReturnType<JWT<JWTPayload>["parse"]>["payload"]) => void;
  setCookie: <T extends keyof Cookies>(
    key: T,
    value: Cookies[T],
    MaxAge?: number,
    Domain?: string,
    Path?: string,
    HttpOnly?: boolean,
    Secure?: boolean,
    SameSite?: "strict" | "lax" | "none",
  ) => void;
};
export type IWebServerProps<JWTPayload extends RecordAny> = {
  prefixPath?: string;
  jwt?: JWT<JWTPayload>;
  maxContentLength?: number;
};
export class WebServer<T extends IWebServerApi, Cookies extends RecordString = {}, JWTPayload extends RecordAny = {}> {
  public readonly prefixPath: string = "";
  public readonly jwt?: JWT<JWTPayload>;
  public readonly maxContentLength: number;

  private readonly routeMap = new Map<string, Array<(params: any) => Promise<any>>>();

  /** 路由前统一处理 */
  public readonly beforeRouteCallbacks: Array<
    (params: IWebServerRequest<any, any, Cookies, JWTPayload>) => Promise<any>
  > = [];
  /** 路由后统一处理 */
  public readonly afterRouteCallbacks: Array<
    (params: IWebServerRequest<any, any, Cookies, JWTPayload>, returnValue: any) => Promise<any>
  > = [];

  constructor(props: IWebServerProps<JWTPayload>) {
    this.prefixPath = props.prefixPath || "";
    this.jwt = props.jwt;
    this.maxContentLength = props.maxContentLength || 10 * 1024 * 1024;
  }

  public onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<any> | false {
    //  response.end("hello world");
    const callbacks = this.routeMap.get(`${request.method} ${request.url}`);
    return callbacks ? this.resolveRequest(callbacks, request, response) : false;
  }

  private async resolveRequest(
    callbacks: Array<(params: any) => Promise<any>>,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    let returnValue: any = undefined;
    const that = this;
    const obj: IWebServerRequest<any, any, Cookies, JWTPayload> = {
      get cookies() {
        return new URLSearchParams(request.headers?.["cookie"]?.replace(/; /g, "&")) as any;
      },
      get searchParams() {
        return new URL(request.url || "", `http://${request.headers.host}`).searchParams as any;
      },

      get reqBody() {
        try {
          if (request.headers["content-type"]?.includes("application/json"))
            return JSON.parse(String(obj.reqBodyBuffer));
        } catch (e) {}
        return {};
      },
      request,
      response,
      reqBodyBuffer: Buffer.allocUnsafe(0),
      tempData: {},
      setJWT(jwtPayload) {
        if (!that.jwt) throw new Error("未设置JWT");
        const jwt: any = "Bearer " + that.jwt.stringify(jwtPayload);
        response.setHeader("authorization", jwt);
        obj.setCookie("authorization", jwt, that.jwt.expTime);
      },
      setCookie(key, value, MaxAge, Domain, Path, HttpOnly, Secure, SameSite) {
        let cookieStr = `${String(key)}=${encodeURIComponent(String(value))}; Path=${Path || "/"}; `;
        if (MaxAge) cookieStr += `Max-Age=${MaxAge}; `;
        if (Domain) cookieStr += `Domain=${Domain}; `;
        if (HttpOnly) cookieStr += `HttpOnly; `;
        if (Secure) cookieStr += `Secure; `;
        if (SameSite) cookieStr += `SameSite=${SameSite}; `;
        response.appendHeader("set-cookie", cookieStr);
      },
    };
    try {
      /** 处理提交的body */
      let contentLength = Number(request.headers["content-length"] || 0);
      if (contentLength) {
        if (contentLength > this.maxContentLength) {
          response.statusCode = 413;
          throw new Error("请求体过大");
        }
        const reqBodyBuffers: Buffer[] = [];
        for await (let chunk of request) {
          if (chunk.length > contentLength) chunk = chunk.subarray(0, contentLength);
          reqBodyBuffers.push(chunk);
          contentLength -= chunk.length;
          if (contentLength <= 0) break;
        }
        obj.reqBodyBuffer = Buffer.concat(reqBodyBuffers);
      }

      if (this.jwt) {
        const authorization =
          (obj.cookies.get("authorization") || request.headers?.["authorization"])
            ?.toString()
            ?.replace("Bearer ", "") || "";
        if (authorization) {
          const jwt = this.jwt.parse(authorization);
          if (jwt && this.jwt.verify(jwt)) obj.jwt = jwt.payload;
        }
      }

      for (const callback of this.beforeRouteCallbacks) returnValue = await callback(obj);
      for (const callback of callbacks) returnValue = await callback(obj);
      for (const callback of this.afterRouteCallbacks) returnValue = await callback(obj, returnValue);
      response.setHeader("Content-Type", "application/json;charset=utf-8");
      returnValue = typeof returnValue === "object" ? JSON.stringify(returnValue) : String(returnValue);
    } catch (e: any) {
      response.setHeader("Content-Type", "text/plain;charset=utf-8");
      returnValue = String(e?.message ?? e);
      if (!response.statusCode || response.statusCode < 400) response.statusCode = 422;
    }
    response.end(returnValue);
    return returnValue;
  }

  public get: WebServerType.MethodHandler<T, "get", Cookies, JWTPayload> = (pathname, callback) =>
    this.addRoute("GET", pathname, callback);
  public post: WebServerType.MethodHandler<T, "post", Cookies, JWTPayload> = (pathname, callback) =>
    this.addRoute("POST", pathname, callback);
  public put: WebServerType.MethodHandler<T, "put", Cookies, JWTPayload> = (pathname, callback) =>
    this.addRoute("PUT", pathname, callback);
  public delete: WebServerType.MethodHandler<T, "delete", Cookies, JWTPayload> = (pathname, callback) =>
    this.addRoute("DELETE", pathname, callback);
  public patch: WebServerType.MethodHandler<T, "patch", Cookies, JWTPayload> = (pathname, callback) =>
    this.addRoute("PATCH", pathname, callback);
  public head: WebServerType.MethodHandler<T, "head", Cookies, JWTPayload> = (pathname, callback) =>
    this.addRoute("HEAD", pathname, callback);

  private addRoute(
    method: string,
    pathname: any,
    callback: (params: IWebServerRequest<any, any, any, any>) => Promise<any>,
  ) {
    const key = `${method} /${this.prefixPath}${pathname}`;
    const callbacks = this.routeMap.get(key) || [];
    callbacks.push(callback);
    this.routeMap.set(key, callbacks);
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
