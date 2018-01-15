import { Remotify, RemotifyListen } from "./remotify";
import * as redis from "redis";

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
		return y + this.x;
	}
	test2 = async (y: number) => y + this.x;
}

async function init() {
	const pub = redis.createClient();
	const sub = pub.duplicate();
	if (process.argv[2] === "b") {
		const r = new Remotify("remotifytest", "cli-" + Math.random(), {
			pub,
			sub,
		});
		const squareR = r.remotify<typeof square>(square.name);
		const testMultiR = r.remotify<typeof testMulti>(testMulti.name);
		const tester = r.remotifyAll<Tester>("tester", ["test1", "test2"]);
		for (const x of [1, 2, 3, 4, 5, 11]) {
			try {
				console.log(x, "* 4 =", await testMultiR(x, "4"));
				console.log(x, "** 2 =", await squareR(x));
				console.log(x, "+ 1 =", await tester.test1(x));
				console.log(x, "+ 1 =", await tester.test2(x));
			} catch (e) {
				console.error("could not compute", x, e);
			}
		}
	} else {
		const t = new Tester();
		const r = new RemotifyListen("rr", { pub, sub });
		r.remotifyListen(square);
		r.remotifyListen(testMulti);
		r.remotifyListenAll(t, "tester");
	}
}

init();
