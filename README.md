Experiment to run arbitrary code in workers - specifically code that isn't controlled and can access the DOM. Problem is, web workers can't synchronously access the DOM.

## Important Notes
- Stopping execution, asking the main thread, and continuing will inherently slow down the script. The trade off here is that, for non-critical path logic like trackers, ads, etc. this is totally ok because they need to be out of the way. This isn't expected to be used by user interactive content.
- **This repo is the base for a proof-of-concept and hasn't had any work put into it that's unrelated to "will this idea work"v*n*


## How it works:

WebWorker + Proxy + SharedArrayBuffer + Atomics 

- initialize the library and decide if worker should be used or fallback to executing within main thread as it always has (see this as progressive enhancement)
- within main thread:
  - setup library to take a script and send it to worker
  - setup listeners and SharedArrayBuffer signals
- for worker: 
  - start worker
  - set up worker environment
    - set up a main thread-like environment where `window` and friends have all of the bells and whistles. Where it needs to fetch data, Proxy or Object getter/setter fields are used to trigger the main thread accessor process
  - execute the script that was passed into the worker environment
  - when the script needs to read from the DOM, we suspend the worker and fetch the result from the main thread and continue

Synchronous main thread access from worker:
- When setting up communication with worker a SharedArrayBuffer (SAB) is established (both threads have access to this).
  - The SAB has two functions - signal information about the content and share the content with the worker. To do that it has initial indexes that provide the signals and information about how to extract the data correctly
    - SAB[0] = INDEX_SET_FLAG - this is the index the worker and thread use to wait on to communicate changes
    - SAB[1] = INDEX_CONTENT_TYPE - what type of content is being transferred - some content is more easily translated
    - SAB[2] = INDEX_CONTENT_SIZE - how many indices of this array is taken by the content
    - SAB[3...N] = INDEX_CONTENT_START - The start of the content and the end of the content is determined by INDEX_CONTENT_SIZE (SAB[2])
- Proxies in the worker will detect that it needs to get content from the main thread, send a postMessage that can be deserialized make the main thread request, then it waits for the SAB[0] to be changed by the main thread. This is the suspension and waiting for the worker to get result back from main.
- The main thread listens for messages, deserialize the accessor request, performs the access, adds the updates the SAB with the new content information then increments SAB[0] that the worker was waiting for.
- The worker is released, looks at SAB for the access information and returns it in the Proxy/Object Getter/Setter.




## To run:
- (once) `npm install`
- `npm start` 
- visit localhost:3000 - open console to see



## To solve:

Solution:
- [] configuration system
- [] primary worker that can spawn and manage sub workers

Running logic in site environment:
- [] synchronous accessor patterns to the native globals on main thread
- [] synchronous accessor patterns to the non-native globals on main thread
- [] globals in the scope of the logic should match main thread (location, etc.)
- [] invoking main thread functions
- [] invoking main thread functions and receiving the resulting values
- [] self, top, parent, opener, etc. mapping
- [] creating scripts should execute within the frame
- [] `this` context properly handled across the boundaries
- [] delete properties
- [] mimic object descriptors to mirror outcomes of enumeration on either side of the boundary
- [] stored object references (var w = window; w.location)
- [] eval inside of the logic might cause issues with stacktrace lookups and might cause weirdness with scope variables
- [] handle function invocations and chaining from the response window.getThing().val.thing()
- [] handle accessor/field reference in the script itself is in brackets or is a variable. e.g. var f = 'href'; location[f]. Current logic assumes the property itself is there. Will need to inspect to left to see if it's a string ref and continue forward. also string literals as field definitions
- [] retaining instance types will be important for some logic so if we transfer over the boundary the class types should be consistent

Running logic on the dom:
- [] accessors to DOM that exists
- [] functions calls on DOM that exists
- [] creating DOM

Delivery:
- [] This should be easily accessible as a CDN resource that any site can drop on their page and the api is available and import scripts works.


Thoughts...

- Perhaps if we solve the Blocking Accessor pattern first that can be the worst case scenario for all globals and accessor patterns BUT it _should_ get most of the accessor and DOM tooling. Then the synchronous accessors for performance improvements can be layered on.
- perhaps we can cache accessor values for each call stack. Like adding a setImmediate or something to get onto the next call stack and that will clear the cache. As logic isn't really expected to change during run to completion


Other opportunities:
- Containerization of scripts with serialized access to what the site allows. Thinking 3rd party plugins where you can execute this and have sync access to somethings but not everything
- Sites can control what apis (like cookies) are used on the site domain by scripts


