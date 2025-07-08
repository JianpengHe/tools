/** 校验网站https://jwt.io/ */
import * as crypto from "crypto";

export type JWTBasePayload = {
  /** exp (Expiration time)：过期时间 */
  exp?: number;
  /** iat (Issued at)：签发时间 */
  iat?: number;
  /** iss (Issuer)：签发人 */
  iss?: string;
  /** sub (Subject)：主题 */
  sub?: string;
  /** jti (JWT ID)：JWT ID */
  jti?: string;
  /** nbf (Not before)：生效时间 */
  nbf?: number;
  /** aud (Audience)：接收者 */
  aud?: string;
};

export class JWS<T extends Record<string, any>> {
  public readonly header: {
    alg: string;
    typ?: string;
  };
  public readonly payload: JWTBasePayload & T;
  public readonly signature: Buffer;
  public readonly headerRAW: string;
  public readonly payloadRAW: string;
  constructor(token: string) {
    const [headerRAW, payloadRAW, signatureRAW] = token.split(".");
    this.signature = JWS.base64urlDecode(signatureRAW);
    this.headerRAW = String(headerRAW);
    this.payloadRAW = String(payloadRAW);
    this.header = JSON.parse(String(JWS.base64urlDecode(this.headerRAW)));
    this.payload = JSON.parse(String(JWS.base64urlDecode(this.payloadRAW)));
  }
  public verify(publicKey: string) {
    const { exp, iat, nbf } = this.payload;
    const now = Date.now() / 1000;

    if (exp && exp < now) return false; //throw new Error("JWT已过期");
    if ((iat && iat > now) || (nbf && nbf > now)) return false; //throw new Error("JWT未生效");

    const data: any = `${this.headerRAW}.${this.payloadRAW}`;
    const alg = String(this.header.alg || "").toUpperCase();
    if (!alg || alg === "none") return true;
    const algorithm = "sha" + alg.substring(2);
    const { signature } = this;
    if (alg.startsWith("HS")) return signature.equals(crypto.createHmac(algorithm, publicKey).update(data).digest());
    if (alg.startsWith("ES")) return crypto.verify(algorithm, data, JWS.getESKey(publicKey), signature);
    if (alg.startsWith("RS")) return crypto.verify(algorithm, data, publicKey, signature);
    if (alg.startsWith("PS")) return crypto.verify(algorithm, data, JWS.getPSKey(publicKey), signature);

    throw new Error("暂不支持" + alg);
  }
  static sign<T extends Record<string, any>>(
    payload: JWS<T>["payload"],
    privateKey: string,
    exp?: number | Date,
    alg = "HS512",
  ): string {
    /** 添加过期时间 */
    if (exp) {
      const now = Math.floor(Date.now() / 1000);
      payload.exp = Math.floor((exp instanceof Date ? exp : new Date((exp + now) * 1000)).getTime() / 1000);
      payload.iat = now;
      payload.nbf = now;
    }
    const headerRAW = JWS.base64url(Buffer.from(JSON.stringify({ alg, typ: "JWT" })));
    const payloadRAW = JWS.base64url(Buffer.from(JSON.stringify(payload)));
    const data: any = `${headerRAW}.${payloadRAW}`;
    if (!alg || alg === "none") return data;

    const algorithm = "sha" + alg.substring(2);
    const format = (signature: Buffer) => data + "." + JWS.base64url(signature);

    if (alg.startsWith("HS")) return format(crypto.createHmac(algorithm, privateKey).update(data).digest());
    if (alg.startsWith("ES")) return format(crypto.sign(algorithm, data, JWS.getESKey(privateKey)));
    if (alg.startsWith("RS")) return format(crypto.sign(algorithm, data, privateKey));
    if (alg.startsWith("PS")) return format(crypto.sign(algorithm, data, JWS.getPSKey(privateKey)));

    throw new Error("暂不支持" + alg);
  }

  static getESKey(key: string): any {
    return {
      key,
      format: "pem",
      dsaEncoding: "ieee-p1363", // 关键：使用 IEEE P1363 格式
    };
  }
  static getPSKey(key: string): any {
    return {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    };
  }

  static base64url(input: Buffer) {
    return input.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  // base64url 解码
  static base64urlDecode(input: string) {
    input = input.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(input + "=".repeat(input.length % 4 === 0 ? 0 : 4 - (input.length % 4)), "base64");
  }
}

/** 以下是测试用例 */
// import { Console } from "./Console";
// function testJWS(alg: string, { privateKey, publicKey }: { privateKey: string; publicKey: string }) {
//   Console.showTitle("测试" + alg);
//   console.log(publicKey);
//   console.log(privateKey);
//   Console.showTitle("开始签名");
//   console.time(alg + "耗时");
//   const jwt = JWS.sign({ aud: "PG", userId: 666 }, privateKey, 20 * 60, alg);
//   console.log(jwt);
//   console.log("签名长度：", jwt.length);
//   Console.showTitle("验证签名");
//   const jws = new JWS(jwt);
//   console.log("解析完成：", new JWS(jwt));
//   console.log("校验结果：", jws.verify(publicKey));
//   console.timeEnd(alg + "耗时");
//   Console.showTitle("测试" + alg + " END");
//   console.log("\n\n");
// }
// /** 压力测试 */
// function stressTesting(alg: string, KEY: { privateKey: string; publicKey: string }, times: number) {
//   Console.showTitle(`压力测试${alg} (${times}次)`);
//   console.time(alg + "耗时");
//   for (let i = 0; i < times; i++) {
//     const jws = new JWS(JWS.sign({ aud: "PG" + i, userId: i }, KEY.privateKey, 1000, alg));
//     if (!jws.verify(KEY.publicKey)) throw new Error("签名校验不通过");
//   }
//   console.timeEnd(alg + "耗时");
// }

// /** 生成密钥 */
// const HS256_KEY = {
//   privateKey: "123456",
//   publicKey: "123456",
// };
// const ES256_KEY = crypto.generateKeyPairSync("ec", {
//   namedCurve: "prime256v1",
//   publicKeyEncoding: {
//     type: "spki",
//     format: "pem",
//   },
//   privateKeyEncoding: {
//     type: "pkcs8",
//     format: "pem",
//   },
// });
// const RS256_KEY = crypto.generateKeyPairSync("rsa", {
//   modulusLength: 2048, // 密钥长度，RS256 建议至少 2048 位
//   publicKeyEncoding: {
//     type: "spki", // 公钥标准，适合 JWT 用的 PEM 格式
//     format: "pem",
//   },
//   privateKeyEncoding: {
//     type: "pkcs8", // 私钥标准
//     format: "pem",
//   },
// });
// const PS256_KEY = crypto.generateKeyPairSync("rsa", {
//   modulusLength: 2048, // 密钥长度，RS256 建议至少 2048 位
//   publicKeyEncoding: {
//     type: "spki", // 公钥标准，适合 JWT 用的 PEM 格式
//     format: "pem",
//   },
//   privateKeyEncoding: {
//     type: "pkcs8", // 私钥标准
//     format: "pem",
//   },
// });

/** 测试用例 */
// testJWS("HS256", HS256_KEY);
// testJWS("ES256", ES256_KEY);
// testJWS("RS256", RS256_KEY);
// testJWS("PS256", PS256_KEY);

/** 压力测试 */
// stressTesting("HS256", HS256_KEY, 1000);
// stressTesting("ES256", ES256_KEY, 1000);
// stressTesting("RS256", RS256_KEY, 1000);
// stressTesting("PS256", PS256_KEY, 1000);

/** JWT封装类，方便使用 */
export class JWT<T extends Record<string, any> & JWTBasePayload> {
  public readonly publicKey: string;
  public readonly privateKey: string;
  public readonly expTime: number;
  public readonly alg?: string;
  constructor(expTime: number, alg: string = "HS512", publicKey: string = "", privateKey: string = publicKey) {
    if (!publicKey) {
      const key = JWT.generateKey(alg);
      publicKey = key.publicKey;
      privateKey = key.privateKey;
    }
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.expTime = expTime;
    this.alg = alg;
  }
  public stringify(payload: T) {
    return JWS.sign(payload, this.privateKey, this.expTime, this.alg);
  }
  public parse(token: string) {
    return new JWS<T>(token);
  }
  public verify(jwt: JWS<T>) {
    return jwt.verify(this.publicKey);
  }
  static generateKey(alg: string = "HS512") {
    if (alg.startsWith("HS")) {
      const privateKey = crypto.randomBytes(32).toString("hex");
      return { publicKey: privateKey, privateKey };
    }

    if (alg.startsWith("RS") || alg.startsWith("PS")) {
      return crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048, // 密钥长度，RS256 建议至少 2048 位
        publicKeyEncoding: {
          type: "spki", // 公钥标准，适合 JWT 用的 PEM 格式
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8", // 私钥标准
          format: "pem",
        },
      });
    }
    if (alg.startsWith("ES")) {
      const map = {
        ES256: "prime256v1",
        ES384: "secp384r1",
        ES512: "secp521r1",
      };
      return crypto.generateKeyPairSync("ec", {
        namedCurve: map[alg],
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      });
    }
    throw new Error("不支持的算法");
  }
}

/** 测试用例 */
// for (const alg of [
//   "HS256",
//   "HS384",
//   "HS512",
//   "ES256",
//   "ES384",
//   "ES512",
//   "RS256",
//   "RS384",
//   "RS512",
//   "PS256",
//   "PS384",
//   "PS512",
// ]) {
//   const jwt = new JWT(1000, alg);

//   const times = alg.startsWith("HS") ? 50000 : 500;
//   console.time(times + "次" + alg);
//   for (let i = 0; i < times; i++) {
//     const token = jwt.stringify({ userId: i, user: "admin" });
//     const data = jwt.parse(token);
//     if (jwt.verify(data) === false) throw new Error(alg + "校验失败");
//   }
//   console.timeEnd(times + "次" + alg);
// }
