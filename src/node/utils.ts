import * as stream from "stream";
export type IReadStream = stream.Readable | stream.Duplex;
export const recvAll = (stream: IReadStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const body: Buffer[] = [];
    stream.on("data", chuck => body.push(chuck));
    stream.once("end", () => resolve(Buffer.concat(body)));
    stream.once("error", reject);
  });