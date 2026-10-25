import type { MfaPrompt, SecondFactor } from "../aula-virtual/client/sso-login.js";

/**
 * Un login que queda esperando el segundo factor entre un request y otro: corre en segundo plano y,
 * cuando le pregunta algo al usuario, `next` lo devuelve para mostrárselo en una página; `answer` le
 * pasa lo que el usuario contestó en el request siguiente.
 */
export class PendingLogin<T> {
    private readonly run: Promise<T>;
    private waiting: { prompt: MfaPrompt; resolve: (answer: string) => void } | null = null;
    private listeners: ((prompt: MfaPrompt) => void)[] = [];

    constructor(start: (secondFactor: SecondFactor) => Promise<T>) {
        this.run = start(
            (prompt) =>
                new Promise((resolve) => {
                    this.waiting = { prompt, resolve };
                    for (const listener of this.listeners.splice(0)) listener(prompt);
                }),
        );
        this.run.catch(() => {});
    }

    /** Espera a que el login termine o le pregunte algo al usuario. */
    next(): Promise<{ done: T } | { prompt: MfaPrompt }> {
        if (this.waiting) return Promise.resolve({ prompt: this.waiting.prompt });
        return Promise.race([
            this.run.then((done) => ({ done })),
            new Promise<{ prompt: MfaPrompt }>((resolve) => this.listeners.push((prompt) => resolve({ prompt }))),
        ]);
    }

    /** Contesta lo que está preguntando; si no pregunta nada (un formulario mandado dos veces), no hace nada. */
    answer(value: string): void {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.resolve(value);
    }
}
