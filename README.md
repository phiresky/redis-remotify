# redis-remotify

A tiny library for remote calls and events via redis.

Install via npm:

    yarn add @phiresky/redis-remotify

## Example use

Say you have a backend like this:

```typescript
class Squarer {
	public async square(x: number) {
		// maybe do some more interesting stuff here
		return x ** 2;
	}
}
```

But you want to use the functions it provides in different processes. With this library, you can start a server process like this:

```typescript
import * as redis from "redis";
import { Listen } from "@phiresky/redis-remotify";

const squarer = new Squarer();

const pub = redis.createClient();
const sub = redis.createClient();
const r = new Listen("backend", { pub, sub });
// add methods to RPC interface with a name like Squarer.square()
r.listenAll(squarer);
```

And then call the functions from one or more separate node processes like this:

```typescript
import { Remotify } from "@phiresky/redis-remotify";

const backend = new Remotify("backend", { pub, sub });
const remoteSquarer = backend.remotifyClass(Squarer);
for (const x of [1, 2, 3, 4, 5, 11]) {
	const res = await remoteSquarer.square(x);
	// typeof res is number as expected
	console.log(x, "^2 =", res);
}
```

Of course it also works with single functions or other non-class objects. A more complete example can be seen in [examples/elaborate.ts](examples/elaborate.ts).
