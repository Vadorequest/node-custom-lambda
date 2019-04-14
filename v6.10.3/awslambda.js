var net = require("net");
var repl = require("repl");
var http = require("http");
var util = require("util");
awslambda = require("./_awslambda");

// Logging helpers

function rt_console_log(message) {
  console.log("[nodejs] " + message);
}

function rt_console_trace(message) {
  console.trace("[nodejs] " + message);
}

function rt_console_error(message) {
  console.error("[nodejs] " + message);
}

// Filter out from stack traces awslambda.js and all frames below it
function customPrepareStackTrace(error, stack) {
  var idx = stack.length;
  for (var i = 0; i < stack.length; i++) {
    if (stack[i].getFileName() == __filename) {
      idx = i;
      break;
    }
  }

  var lines = new Array();
  lines[0] = error;

  for (var i = 0; i < idx; i++) {
    var frame = stack[i];
    var line;
    try {
      line = frame.toString();
    } catch (e) {
      try {
        line = "<error: " + e + ">";
      } catch (ee) {
        line = "<error>";
      }
    }
    lines[i + 1] = " at " + line;
  }
  return lines.join("\n");
}

// node.js stack traces have the error message on the first line.
// Since we already report the error message in another field, strip it from the stack to avoid redundancy.
function stripMessageFromStack(stack) {
  if (Error.prepareStackTrace != customPrepareStackTrace || (typeof stack === 'undefined') || stack == null) {
    return null;
  } else {
    return stack.slice(stack.indexOf("\n") + 1);
  }
}

function wrap_user_handler(user_handler, mode) {
  // Dispatch to handler
  switch (mode) {
    case "http":
      return wrap_http(user_handler);
    case "json":
      return wrap_json(user_handler);
    case "event":
      return wrap_event_invoke(user_handler);
    default:
      return function (invokeid, sock) {
        sock.destroy();
        awslambda.report_fault(invokeid, "invalid mode specified: " + mode, null, null);
        awslambda.report_done(invokeid);
      }
  }
}

function wrap_event_invoke(user_handler) {
  return function (invokeid, json_string, event_response, postDone) {
    try {
      var args = JSON.parse(json_string);
    } catch (err) {
      awslambda.report_fault(invokeid, "Unable to parse input as json");
      postDone();
      return;
    }
    user_handler(args, event_response);
  }
}

function wrap_http(user_handler) {
  var handler_with_invokeid = function (request, response) {
    request._aws_invokeid = request.socket._aws_invokeid;
    user_handler(request, response);
  };
  var server = http.createServer(handler_with_invokeid);

  // Catches all errors originating from the client connection, including:
  // invalid HTTP request
  // socket errors
  server.on('clientError', function (exception, sock) {
    awslambda.report_fault(sock._aws_invoke_id, "Unable to parse HTTP request", exception, stripMessageFromStack(exception.stack));
    sock.destroy();
  });
  return function (invokeid, sock) {
    sock._aws_invokeid = invokeid;
    server.emit('connection', sock);
  }
}

function wrap_json(handler) {
  return function (invokeid, sock) {
    sock.on('data', function (data) {
      try {
        var args = JSON.parse(data);
      } catch (err) {
        awslambda.report_fault(invokeid, "Unable to parse input as json", err, null);
        sock.destroy();
        return;
      }
      handler(args, function (response) {
        try {
          var output = JSON.stringify(response, null);
        } catch (err) {
          awslambda.report_fault(invokeid, "Unable to dump output as json", err, null);
          sock.destroy();
          return;
        }
        sock.write(output);
        sock.end();
      });
    });
  }
}

function set_creds(credentials) {
  if (credentials === undefined) {
    return;
  }
  if (credentials['key']) {
    process.env['AWS_ACCESS_KEY_ID'] = credentials['key'];
  }
  if (credentials['secret']) {
    process.env['AWS_SECRET_ACCESS_KEY'] = credentials['secret'];
  }
  if (credentials['session']) {
    process.env['AWS_SESSION_TOKEN'] = credentials['session'];
  }
}

function get_handlers(handler_string, mode, suppress_init) {
  if (suppress_init) {
    return get_handlers_delayed(handler_string, mode);
  } else {
    return get_handlers_immediate(handler_string, mode);
  }
}

/**
 * delay loading the user's code until an invoke occurs, to ensure we don't crash the runtime.
 */
function get_handlers_delayed(handler_string, mode) {
  var modules_loaded = false;
  var real_request_handler = undefined;

  var request_handler = function (invokeid, sock) {
    if (modules_loaded) {
      return real_request_handler(invokeid, sock);
    } else {
      try {
        var handlers = get_handlers_immediate(handler_string, mode);
        var init_handler = handlers[0];
        real_request_handler = handlers[1];
        /*
         * We can't call the user's init function here.
         * Nodejs has an amazing amount of quirks, bugs, and weird behavior.
         * In this case, if the user's init function does something asynchronous,
         * nodejs by default reads data from the socket as it becomes available and stuffs it
         * in an in-memory buffer. The HTTP parser that eventually gets attached to the socket
         * ignores this buffer, so it misses part or all of the HTTP request.
         */
        /*
        init_handler(function() {
            return real_request_handler(invokeid, sock);
        });*/
        return real_request_handler(invokeid, sock);
      } finally {
        modules_loaded = true;
      }
    }
  };
  return [
    function (done) {
      done();
    }, request_handler
  ];
}

function get_handlers_immediate(handler_string, mode) {
  var app_parts = handler_string.split(".");
  var init_handler = function (done) {
    done();
  }
  var request_handler;
  var finisher;
  if (mode == 'event') {
    finisher = function (invokeid, json_string, event_response, postDone) {
      event_response.done();
    };
  } else {
    finisher = function (invokeid, sock) {
      sock.destroy();
    }
  }

  if (app_parts.length != 2) {
    request_handler = function () {
      awslambda.report_fault(arguments[0], "Bad handler " + handler_string);
      finisher.apply(this, arguments);
    }
  } else {
    var module_path = app_parts[0];
    var handler_name = app_parts[1];
    var init_handler_name = "init";
    try {
      var app = require(module_path);
      init_handler = app[init_handler_name] || init_handler;

      var user_handler = app[handler_name];

      if (user_handler === undefined) {
        request_handler = function () {
          awslambda.report_fault(arguments[0], "Handler '" + handler_name + "' missing on module '" + module_path + "'", null, null);
          finisher.apply(this, arguments);
        };
      } else {
        request_handler = wrap_user_handler(user_handler, mode);
      }
    } catch (e) {
      if (e.code == "MODULE_NOT_FOUND") {
        request_handler = function () {
          awslambda.report_fault(arguments[0], "Unable to import module '" + module_path + "'", e, stripMessageFromStack(e.stack));
          finisher.apply(this, arguments);
        };
      } else if (e instanceof SyntaxError) {
        request_handler = function () {
          awslambda.report_fault(arguments[0], "Syntax error in module '" + module_path + "'", e, stripMessageFromStack(e.stack));
          finisher.apply(this, arguments);
        };
      } else {
        request_handler = function () {
          awslambda.report_fault(arguments[0], "module initialization error", e, stripMessageFromStack(e.stack));
          finisher.apply(this, arguments);
        }
      }
    }
  }

  if (init_handler === undefined) {
    init_handler = function (on_done) {
      on_done();
    }
  }
  return [init_handler, request_handler];
}

function do_init(options) {
  var init_invokeid = options['invokeid'];
  awslambda.report_running(init_invokeid);

  global_invokeid = init_invokeid;
  set_creds(options['credentials']);

  //monkey patching to change console.log behavior
  var old_console_log = console.log;

  function pretty_console_log() {
    var dateString = new Date().toISOString();

    //This is how we used to print before
    //util.print(dateString + " RequestID: " + global_invokeid + " ");
    //old_console_log.apply(console, arguments);

    var message = dateString + "\t" + global_invokeid + "\t" + util.format.apply(this, arguments) + "\n";
    awslambda.send_console_logs(message);
  }

  console.log = console.error = console.warn = console.info = pretty_console_log;

  var handler_string = options['handler'];
  var handlers = get_handlers(handler_string, options['mode'], options['suppress_init']);
  var init_handler = handlers[0];
  var request_handler = handlers[1];
  var callback = function (options) {
    return invoke_callback(request_handler, options);
  };

  function on_init_done() {
    awslambda.report_done(init_invokeid);
    awslambda.wait_for_invoke_nb(callback);
  };
  try {
    init_handler(on_init_done);
  } catch (e) {
    awslambda.report_fault(init_invokeid, "init handler error", e, stripMessageFromStack(e.stack));
    on_init_done();
  }
}

function finish_invoke(request_handler, invokeid, error, message) {
  awslambda.report_done(invokeid, error, message);

  //when the task is complete, listen for a new task
  function callback(options) {
    return invoke_callback(request_handler, options);
  };
  awslambda.wait_for_invoke_nb(callback);
}

function invoke_callback(request_handler, options) {
  var invokeid = options['invokeid'];
  var event_body = options['eventbody'];
  var sockfd = options['sockfd'];
  global_invokeid = invokeid;
  set_creds(options['credentials']);
  if (event_body && sockfd < 0) {
    var doneStatus = false;
    var postDone = function (error, message) {
      finish_invoke(request_handler, invokeid, error, message);
    };

    function LambdaEventResponse(invokeid) {
      this.invokeid = invokeid;
    }

    LambdaEventResponse.prototype.done = function (err, message) {
      if (doneStatus) {
        return;
      }
      doneStatus = true;
      var error = null;
      if (!(typeof err == "undefined" || (typeof err == "object" && !err))) {
        error = util.format(err);
        console.log(error);
      }
      /*
       * use a timeout to perform the operation once the user gives up control of the event thread
       * This is how HTTP handler works right now
      */
      setTimeout(function () {
        postDone(error, message);
      }, 0);
    }

    event_response = new LambdaEventResponse(invokeid);
    request_handler(invokeid, event_body, event_response, postDone);
  } else if (!event_body && sockfd >= 0) {
    var sockopts = {
      fd: sockfd,
      allowHalfOpen: true,
      readable: true,
      writable: true
    };
    global_data_sock = new net.Socket(sockopts);
    global_data_sock.on('close', function () {
      finish_invoke(request_handler, invokeid);
    });
    request_handler(invokeid, global_data_sock);
  } else {
    awslambda.report_fault(invokeid, "invalid args - eventbody = " + event_body + " socket =" + sockfd, null, null);
    finish_invoke(request_handler, invokeid);
  }
}

var global_data_sock = undefined;
var global_invokeid = undefined;

exports.start_runtime = function () {
  Error.prepareStackTrace = customPrepareStackTrace;

  // Load native runtime
  try {
    //TODO define native functions for logging locally instead of to cloudwatch
    rt_console_log("Loading runtime");
  } catch (e) {
    if (e.code == "MODULE_NOT_FOUND") {
      rt_console_log("Lambda runtime not found");
      return;
    } else {
      throw e;
    }
  }

  // Init runtime
  rt_console_log('Initializing runtime');

  var options = awslambda.init_runtime();
  do_init(options);
}

process.on('uncaughtException', function (e) {
  awslambda.report_fault(global_invokeid, "Failure while running task", e, stripMessageFromStack(e.stack));
  if (global_data_sock !== undefined) {
    global_data_sock.destroy();
  }
});
