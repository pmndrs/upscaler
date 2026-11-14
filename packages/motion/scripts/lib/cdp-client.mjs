// Copied from the upscaler repo's scripts/cdp-client.mjs (MOTION-VECTORS-PLAN §3.4: small glue is
// copied, not shared), so the motion package needs nothing from the upscaler.
export class CDP {
    id = 0; requests = new Map(); events = [];
    constructor(socket) {
        this.socket = socket;
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const request = this.requests.get(message.id);
                this.requests.delete(message.id);
                if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
                else request?.resolve(message.result);
            } else this.events.push(message);
        });
    }
    static async connect(url) {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        return new CDP(socket);
    }
    send(method, params = {}, timeoutMs = 45000) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
            this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
    }
    close() { this.socket.close(); }
}
