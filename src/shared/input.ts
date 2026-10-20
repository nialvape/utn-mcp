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

/**
 * Elige una de `options` con las flechas (o su número) y Enter; devuelve el índice. Sin terminal
 * interactiva (stdin redirigido) muestra la lista numerada y pide el número. Enter solo elige `initial`.
 */
export async function askChoice(question: string, options: string[], initial = 0): Promise<number> {
    if (!stdin.isTTY) {
        const list = options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
        const answer = await ask(`${question}\n${list}\nElegí una [${initial + 1}]: `);
        if (!answer) return initial;
        const index = Number(answer) - 1;
        if (!options[index]) throw new Error(`"${answer}" no es una opción: elegí un número del 1 al ${options.length}.`);
        return index;
    }

    return new Promise((resolve, reject) => {
        let selected = initial;
        // Reescribe la lista en el lugar: sube tantas líneas como opciones y borra cada una.
        const render = (redraw: boolean) => {
            if (redraw) stderr.write(`\x1b[${options.length}A`);
            for (const [i, o] of options.entries()) stderr.write(`\x1b[2K${i === selected ? "❯" : " "} ${o}\n`);
        };

        const onData = (chunk: string) => {
            if (chunk === "\u0003") {
                done();
                reject(new Error("Cancelado"));
                return;
            }
            if (chunk === "\r" || chunk === "\n") {
                done();
                stderr.write(`\x1b[${options.length + 1}A\x1b[J${question} ${options[selected]}\n`);
                resolve(selected);
                return;
            }
            if (chunk === "\x1b[A") selected = (selected - 1 + options.length) % options.length;
            else if (chunk === "\x1b[B") selected = (selected + 1) % options.length;
            else if (options[Number(chunk) - 1]) selected = Number(chunk) - 1;
            else return;
            render(true);
        };

        const done = () => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            stderr.write("\x1b[?25h"); // vuelve a mostrar el cursor
        };

        stderr.write(`\x1b[?25l${question} (flechas y Enter)\n`);
        render(false);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        stdin.on("data", onData);
    });
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
