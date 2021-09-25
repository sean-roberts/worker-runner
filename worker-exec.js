// [INDEX_SET_FLAG, INDEX_CONTENT_TYPE, INDEX_CONTENT_SIZE, INDEX_CONTENT_START...CONTENT]
// INDEX_CONTENT_SIZE = CONTENT.length
const INDEX_SET_FLAG = 0;
const INDEX_CONTENT_TYPE = 1;
const INDEX_CONTENT_SIZE = 2;
const INDEX_CONTENT_START = 3;

const CONTENT_TYPE_UNKNOWN = 1;
const CONTENT_TYPE_NUMBER = 1;
const CONTENT_TYPE_BOOLEAN = 2;
const CONTENT_TYPE_STRING = 3;
const CONTENT_TYPE_JSON = 4;
const CONTENT_TYPE_UNDEFINED = 5;
const CONTENT_TYPE_NULL = 6;
const CONTENT_TYPE_NAN = 7;

const ACCESSOR_TYPE_GET = 'get';
const ACCESSOR_TYPE_SET = 'set';

let defaultConfig = {
  debug: false
};
let config = {};

const log = (...args)=> config.debug === true && console.log(...args);


// the idea behind the blocking async accessor is that it is a sharedarraybuffer
// between the threads that can be used to know when a value is provided
// to either sides when we have to pause execution in order
// to get the content from the main thread. So it will be used to
// provide a blocking behavior within this thread but the process
// of getting the value is async.
let blockingAsyncAccessorArray = [];


self.addEventListener('message', function (e) {
  var data = e.data;

  if(data.workerConfig){
    config = {...defaultConfig, ...config, ...data.workerConfig};
    log('config set', config);
  }

  if(data.blockingAsyncAccessorArrayBuffer){
    blockingAsyncAccessorArray = new Int32Array(data.blockingAsyncAccessorArrayBuffer);
    log('blockingAsyncAccessorArray set');
  }

  if(data.command){
    switch(data.command){
      case 'init':
        // TODO: assert we have everything necessary 

        initialize(data.commandOptions);
        break;
      default:
        log('Unknown command', data.command);
    }
  }

}, false);


function initialize(commandOptions){
  log('initializing...')

  if (!commandOptions){
    log('could not initialize because no options were sent');
    return;
  }

  if(commandOptions.inlineScript){
    log('command initialized with inlineScript');
    executeScriptRuntime(commandOptions.inlineScript);
  }
}

// eval'd scripts include the actual function definition
// at runtime. So this means the script string is wrapped
// withing a function(..){ script } layout. This function
// generates a noop function to understand that wrapper sizing
// so that we can account for it in stacktrace inspection
// or other offset needs
function evaluatedScriptPadding (){
  const noopFn = new Function('noop');
  const lines = noopFn.toString().split('\n');
  const scriptStartEndIndex = lines.indexOf('noop');
  return {
    preScriptPadding: scriptStartEndIndex,
    postScriptPadding: lines.length - scriptStartEndIndex
  };
}

function executeScriptRuntime(scriptString){
  const globals = getExecutionGlobals({ executedScriptRef: scriptString  });
  const exec = new Function(...Object.keys(globals), scriptString);
  
  // hold on to your butts!
  // .call to set the global `this` context for the executing script
  exec.call(globals.window, ...(Object.values(globals)));
}



function getExecutionGlobals({ executedScriptRef }){

  const { preScriptPadding } = evaluatedScriptPadding();


  function accessorGetHandler(target, property, receiver) {

    // TODO: memoize this lookup
    const expectingObject = isExpectingObjectRef({ preScriptPadding, executedScriptRef, property })

    const accessorAPI = target._accessorAPI ? `${target._accessorAPI}.${property}` : property;

    if (!expectingObject) {
      return blockingAsyncAccessor(ACCESSOR_TYPE_GET, accessorAPI);
    } 

    return new Proxy({
      _accessorAPI: accessorAPI
    }, {
      get: accessorGetHandler,
      set: accessorSetHandler
    });
  }

  function accessorSetHandler(target, property, value) {
    const accessorAPI = target._accessorAPI ? `${target._accessorAPI}.${property}` : property;
    return blockingAsyncAccessor(ACCESSOR_TYPE_SET, accessorAPI, value);
  }

  const window = new Proxy({
    _accessorAPI: 'window',
    globalThis: this,
    location: new Proxy({
      _accessorAPI: 'window.location',
    }, {
      get: accessorGetHandler,
      set: accessorSetHandler
    }),
    document: new Proxy({
      _accessorAPI: 'window.document',
    }, {
      get: accessorGetHandler,
      set: accessorSetHandler
    })
  }, {
    get: function (target, property, receiver){
      if(target[property]){
        return target[property];
      }
      return accessorGetHandler(target, property, receiver);
    },
    set: accessorSetHandler
  });
  
  return {
    window,
    ...window
  };
}


let currentSetFlagVal = 0;
function blockingAsyncAccessor(accessType, accessorAPI, accessorVal){
  
  // log('blockingAsyncAccessor', accessType, accessorAPI, accessorVal)

  self.postMessage({
    mainThreadAccessor: true,
    // lol wut
    id: performance.now(),
    accessor: {
      type: accessType,
      api: accessorAPI,
      value: accessorVal
    }
  });

  Atomics.wait(blockingAsyncAccessorArray, INDEX_SET_FLAG, currentSetFlagVal, 3000);
  // allow mainthread to change this val as needed so that
  // we can look at the content specifics when we have a change
  // after a block
  currentSetFlagVal = blockingAsyncAccessorArray[INDEX_SET_FLAG];

  const contentType = blockingAsyncAccessorArray[INDEX_CONTENT_TYPE];
  const contentSize = blockingAsyncAccessorArray[INDEX_CONTENT_SIZE];

  let retVal;
  
  if(contentType === CONTENT_TYPE_STRING){
    retVal = String.fromCharCode.apply(null, blockingAsyncAccessorArray.subarray(INDEX_CONTENT_START, contentSize + INDEX_CONTENT_START))
  } else if (contentType === CONTENT_TYPE_NUMBER){
    retVal = blockingAsyncAccessorArray[INDEX_CONTENT_START];
  }else if(contentType === CONTENT_TYPE_UNKNOWN){
    throw new Error('content type unknown');
  }
  
  return retVal;
}

// TODO: this logic should be able to provide
// if it's expecting an object ref, if it's a function call,
// etc.
function isExpectingObjectRef({ preScriptPadding, executedScriptRef, property }){
  // just used to determine if this is 
  // expected to return an object so that we
  // know when to stop chaining Proxies.

  let expectingObjectRef = false;
  try {
    throw new Error('stack getter');
  } catch (e) {
    const stackEntries = e.stack.split('\n');
    const evalEntry = stackEntries.find((line) => {
      if (line.includes('eval')) {
        return line
      }
    });

    if (evalEntry) {
      const [, lineStr, columnStr] = /<anonymous>:(\d+):(\d+)/gm.exec(evalEntry);
      // this line represents the line to find the reference in the executed script
      // it will be off by the padding + one because the lookup is base 0 index
      const line = parseInt(lineStr, 10) - preScriptPadding - 1;
      const column = parseInt(columnStr, 10);
      const scriptLine = executedScriptRef.split('\n')[line];

      const nextChar = scriptLine[column - 1 + property.length];
      expectingObjectRef = ['.', '['].includes(nextChar);
    }
  }

  return expectingObjectRef;
}