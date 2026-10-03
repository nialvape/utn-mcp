import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";

export async function ask(question: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stderr });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
}

export function askHidden(question: string): Promise<string> {
    if (!stdin.isTTY) return ask(question);

    return new Promise((resolve, reject) => {
        stderr.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let value = "";

        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") {
                    done();
                    resolve(value);
                    return;
                }
                if (ch === "\u0003") {
                    done();
                    reject(new Error("Cancelado"));
                    return;
                }
                if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
                else value += ch;
            }
        };

        const done = () => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            stderr.write("\n");
        };

        stdin.on("data", onData);
    });
}
