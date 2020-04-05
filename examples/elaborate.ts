import { Remotify, Listen } from "../src/remotify";
import { sleep } from "../src/util";
import * as redis from "redis";

const mode = process.argv[2];
if (!mode) {
	console.error("usage: ts-node examples/elaborate.ts {backend|client}");
}

function square(x: number) {
	if (x > 10) throw Error("too large");
	return x ** 2;
}

function testMulti(a: number, b: string) {
	return a * +b;
}

class Tester {
	x = 1;

	async test1(y: number) {
		await sleep(500);
		return y + this.x;
	}
}

async function init() {
	const pub = redis.createClient();
	const sub = pub.duplicate();

	if (mode === "client") {
		const r = new Remotify("remotifytest", {
			pub,
			sub,
		});
		await sleep(100);
		const squareR = r.remotifyFunction(square);
		// same thing but by name (this way the function won't be imported into your client process at all)
		const testMultiR = r.remotify<typeof testMulti>(testMulti.name);

		const tester = r.remotifyClass(Tester);
		// same thing but allowing typescript to eliminate the class import for runtime
		// const tester = r.remotifyAll<Tester>("tester", ["test1", "test2"]);
		for (const x of [1, 2, 3, 4, 5, 11]) {
			try {
				console.log(x, "* 4 =", await testMultiR(x, "4"));
				console.log(x, "** 2 =", await squareR(x));
				console.log(x, "+ 1 =", await tester.test1(x));
			} catch (e) {
				console.error("could not compute", x, e);
			}
		}
	} else if (mode === "backend") {
		const t = new Tester();
		const r = new Listen("remotifytest", { pub, sub });
		r.listen(square);
		r.listen(testMulti);
		r.listenAll(t);
	}
}

init();
