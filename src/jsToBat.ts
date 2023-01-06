import * as fs from "fs";
const data = `/** 2>nul
@echo off
echo ===start at %date% %time%===
echo= 
echo ===start at %date:~0,10% %time%=== >> %0.error.log
echo= >> %0.error.log
node %0 2>> %0.error.log
%0
exit
**/
`;
(async () => {
    for (const dirent of await fs.promises.readdir("./", { withFileTypes: true })) {
        if (dirent.isDirectory() || !/\.js$/.test(dirent.name)) {
            continue;
        }
        const f = fs.createWriteStream(dirent.name + ".bat");
        f.write(data, () => {
            fs.createReadStream(dirent.name).pipe(f)
        })
    }
})()