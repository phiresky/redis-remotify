import * as redis from "redis";
export { redis };
import * as _debug from "debug";
import { sleep } from "./util";
import * as crypto from "crypto";

const debug = _debug("remotify");

type Call = {
	clientid: string;
	callback: number;
	arguments: any[];
};

type Callback = {
	callback: number;
	success: boolean;
	result: any;
};

/**
 * make sure errors are preserved over the wire
 */
function jsonReplacer(_key: string, e: any) {
	if (e instanceof Error) {
		const obj: any = {
			message: e.message,
			stack: e.stack,
			name: e.name,
		};
		for (const k of Object.keys(e)) obj[k] = (e as any)[k];
		return obj;
	}
	return e;
}
export function getAllRelevantFunctions<T, A extends Extract<keyof T, string>>(
	obj: T,
): A[] {
	let objProto = obj;
	let props: A[] = [];
	do {
		props = props.concat(Object.getOwnPropertyNames(objProto) as A[]);
	} while ((objProto = Object.getPrototypeOf(objProto)) !== Object.prototype);

	return props.filter(
		unbound =>
			unbound !== "constructor" && typeof obj[unbound] === "function",
	);
}
const timedout = Symbol("timedout");
export class Listen {
	pubClient: redis.RedisClient;
	subClient: redis.RedisClient;
	fns = new Map<string, (...args: any[]) => Promise<any>>();

	constructor(
		private serverid: string,
		clients: { pub: redis.RedisClient; sub: redis.RedisClient },
		private config = { jsonReplacer },
	) {
		this.pubClient = clients.pub;
		this.subClient = clients.sub;
		this.subClient.on("message", this.onCall);
	}
	private onCall = async (ns: string, str: string) => {
		const [, _remotify, _serverid, _call, fnname] = ns.split("/");
		if (_remotify !== "remotify") return;
		if (_serverid !== this.serverid) return;
		if (_call !== "call") return;
		const fn = this.fns.get(fnname);
		let callback: Callback;
		const data: Call = JSON.parse(str);
		if (!fn) {
			callback = {
				callback: data.callback,
				success: false,
				result: `unknown function "${fnname}"`,
			};
		} else {
			try {
				callback = {
					callback: data.callback,
					success: true,
					result: await fn(...data.arguments),
				};
			} catch (result) {
				callback = {
					callback: data.callback,
					success: false,
					result,
				};
			}
		}
		this.pubClient.publish(
			`/remotify/${this.serverid}/callback/${data.clientid}`,
			JSON.stringify(callback, this.config.jsonReplacer),
		);
	};
	public listen(fn: (...args: any[]) => any, fnname = fn.name) {
		console.log("listening", fnname);
		this.subClient.subscribe(`/remotify/${this.serverid}/call/${fnname}`);
		this.fns.set(fnname, fn);
	}
	public listenAll<T>(obj: T, prefix = obj.constructor.name) {
		for (const unbound of getAllRelevantFunctions(obj)) {
			this.listen(
				((obj[unbound] as any) as Function).bind(obj),
				prefix + "." + unbound,
			);
		}
	}
}
const reservedNamesArray = [
	...Object.getOwnPropertyNames(Object.prototype),
	"inspect", // node thing
];
const reservedNames: { [k: string]: boolean } = Object.assign(
	{},
	...reservedNamesArray.map(k => ({ [k]: true })),
);

function randomid() {
	return crypto.randomBytes(20).toString("hex");
}
function defaultConfig() {
	return {
		clientid: randomid(),
		callbackTimeout: 60 * 1000,
	};
}
type Config = ReturnType<typeof defaultConfig>;

export class Remotify {
	pubClient: redis.RedisClient;
	subClient: redis.RedisClient;
	private callbacks = new Map<
		number,
		{ resolve: (arg: any) => void; reject: (arg: any) => void }
	>();
	private cbCounter = 0;
	private config: Config;
	constructor(
		private serverid: string,
		clients: { pub: redis.RedisClient; sub: redis.RedisClient },
		config: Partial<Config> = {},
	) {
		this.pubClient = clients.pub;
		this.subClient = clients.sub;
		this.config = { ...defaultConfig(), ...config };

		this.subClient.on("message", this.onCallback);
		this.subClient.subscribe(
			`/remotify/${this.serverid}/callback/${this.config.clientid}`,
		);
	}
	private addCallback<T>() {
		const id = ++this.cbCounter;
		return {
			id,
			promise: new Promise<T>((resolve, reject) => {
				this.callbacks.set(id, {
					resolve: (result: any) => {
						this.callbacks.delete(id);
						resolve(result);
					},
					reject: (result: any) => {
						this.callbacks.delete(id);
						reject(result);
					},
				});
			}),
		};
	}
	private onCallback = (ns: string, str: string) => {
		const [, _remotify, _ns, _callback, ,] = ns.split("/");
		if (_remotify !== "remotify") return;
		if (_ns !== this.serverid) return;
		if (_callback !== "callback") return;
		const data: Callback = JSON.parse(str);
		const cb = this.callbacks.get(data.callback);
		if (cb) {
			(data.success ? cb.resolve : cb.reject)(data.result);
		} else {
			console.error("can't find callback for", data.callback);
		}
	};
	public remotify<T>(fnname: string): T {
		return ((async (...args: any[]) => {
			const { id, promise } = this.addCallback<T>();
			const data: Call = {
				clientid: this.config.clientid,
				callback: id,
				arguments: args,
			};
			const timeId = `${fnname} ${id}`;
			if (debug.enabled) console.time(timeId);
			const isDown = new Promise((res, rej) =>
				this.pubClient.publish(
					`/remotify/${this.serverid}/call/${fnname}`,
					JSON.stringify(data),
					(err, listenedCount) => {
						if (err) rej(err);
						else if (listenedCount === 0) {
							const error = new Error(
								this.serverid +
									" backend is down or method does not exist",
							);
							(error as any).cause = "remotifyBackendDown";
							rej(error);
						} else return res();
					},
				),
			);
			const result = await Promise.race([
				Promise.all([isDown, promise]),
				sleep(this.config.callbackTimeout).then(() => timedout),
			]);
			if (debug.enabled) console.timeEnd(timeId);
			if (result === timedout) {
				if (debug.enabled) console.log(timeId, "timeout");
				return Promise.reject({
					cause: "timeout",
					fnname,
					args,
					message: "Timeout",
				});
			} else return (result as any)[1];
		}) as any) as T;
	}
	/**
	 *
	 * @param fnnames array of functions to forward. if null, return a proxy that implicitly forwards every function
	 */
	public remotifyAll<T>(prefix: string, fnnames: string[] | null = null): T {
		if (fnnames === null) {
			return new Proxy(
				{},
				{
					get: (_, fnname) => {
						if (typeof fnname === "symbol") return undefined;
						if (reservedNames[fnname]) return undefined;
						return this.remotify(prefix + "." + fnname);
					},
				},
			) as T;
		} else {
			const obj: any = {};
			for (const fnname of fnnames) {
				obj[fnname] = this.remotify(prefix + "." + fnname);
			}
			return obj as T;
		}
	}

	public remotifyFunction<T extends (...args: any[]) => any>(fn: T) {
		return this.remotify<typeof fn>(fn.name);
	}

	public remotifyClass<T>(
		cls: new (...args: any[]) => T,
		prefix: string = cls.name,
	): T {
		const fns = getAllRelevantFunctions(cls.prototype);
		return this.remotifyAll<T>(prefix, fns);
	}
}

export class RedisEventPublisher<T extends { [name: string]: any }> {
	constructor(private ns: string, private pubClient: redis.RedisClient) {}

	publish<K extends keyof T>(event: K, data: T[K]) {
		this.pubClient.publish(
			`/remotifyEvent/${this.ns}`,
			JSON.stringify({ event, data }),
		);
	}
}

export class RedisEventSubscriber<T extends { [name: string]: any }> {
	constructor(
		private ns: string,
		private subClient: redis.RedisClient,
		private listener: { [k in keyof T]: (data: T[k]) => void },
	) {
		this.subClient.subscribe(`/remotifyEvent/${this.ns}`);
		this.subClient.on("message", this.onEvent);
	}
	onEvent = (ns: string, dataStr: string) => {
		const [, _remotifyEvent, _ns] = ns.split("/");
		if (_remotifyEvent !== "remotifyEvent") return;
		if (_ns !== this.ns) return;
		const { event, data } = JSON.parse(dataStr);
		if (!(event in this.listener)) {
			console.warn("unknown event", event);
		} else {
			this.listener[event](data);
		}
	};
}
