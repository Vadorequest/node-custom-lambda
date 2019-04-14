//
//  Node.js runtime.cc
//  Lambda
//
//  Copyright (c) 2013 Amazon. All rights reserved.
//

#include <node.h>
#include <v8.h>
#include <uv.h>

#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/un.h>

extern "C" {
#include "runtime.h"
#include "util.h"
}

#define TYPE_ERROR(msg) ThrowException(Exception::TypeError(String::New(msg)));

namespace awslambda {

using namespace node;
using namespace v8;

static Handle<Value> ReceiveStart()
{
    sb_start_request request;
    HandleScope scope;

    if (runtime_recv_start(__runtime, &request)) {
        return scope.Close(ThrowException(ErrnoException(errno, "receive_start")));
    }

    Handle<Object> credentials = Object::New();
    credentials->Set(String::New("key"), String::New(request.credentials.key));
    credentials->Set(String::New("secret"), String::New(request.credentials.secret));
    credentials->Set(String::New("session"), String::New(request.credentials.session));

    Handle<Object> object = Object::New();
    object->Set(String::New("invokeid"), String::New(request.invokeid));
    object->Set(String::New("handler"), String::New(request.handler));
    object->Set(String::New("mode"), String::New(ENUM_STRING(lambda_runtime_mode, request.mode)));
    object->Set(String::New("credentials"), credentials);
    object->Set(String::New("suppress_init"), Boolean::New(request.suppress_user_init_function));

    return scope.Close(object);
}

static Handle<Value> ReportRunning(const Arguments& args)
{
    HandleScope scope;

    if (!__runtime) {
        return ThrowException(Exception::Error(String::New(RUNTIME_ERROR_UNINITIALIZED)));
    }

    String::Utf8Value invokeid(args[0]);

    if (runtime_report_running(__runtime, *invokeid)) {
        return ThrowException(ErrnoException(errno, "report_running"));
    }

    return scope.Close(v8::Null());
}

static Handle<Value> ReportDone(const Arguments& args)
{
    HandleScope scope;

    if (!__runtime) {
        return ThrowException(Exception::Error(String::New(RUNTIME_ERROR_UNINITIALIZED)));
    }

    if (args.Length() < 1) {
        return TYPE_ERROR(RUNTIME_ERROR_INVALID_ARGS);
    }

    String::Utf8Value invokeid(args[0]);
    String::Utf8Value errorAsString(args[1]);
    String::Utf8Value messageAsString(args[2]);

    char const *error = NULL;
    if (!((*args[1])->IsNull() || (*args[1])->IsUndefined())) {
        error = *errorAsString;
    }

    char const *message = NULL;
    if (!((*args[2])->IsNull() || (*args[2])->IsUndefined())) {
        message = *messageAsString;
    }


    if (runtime_report_done(__runtime, *invokeid, error, message)) {
        return ThrowException(ErrnoException(errno, "report_done"));
    }

    return scope.Close(v8::Null());
}

static Handle<Value> ReportFault(const Arguments& args)
{
    HandleScope scope;

    if (args.Length() > 4) {
        return TYPE_ERROR(RUNTIME_ERROR_INVALID_ARGS);
    }

    String::Utf8Value invokeid(args[0]);
    String::Utf8Value msg(args[1]);
    String::Utf8Value exceptionAsString(args[2]);
    String::Utf8Value traceAsString(args[3]);

    char const *exception = NULL;
    if (!((*args[2])->IsNull() || (*args[2])->IsUndefined())) {
        exception = *exceptionAsString;
    }

    char const *trace = NULL;
    if (!((*args[3])->IsNull() || (*args[3])->IsUndefined())) {
        trace = *traceAsString;
    }

    if (runtime_report_fault(__runtime, *invokeid, *msg, exception, trace)) {
        return ThrowException(ErrnoException(errno, "report_fault"));
    }

    return scope.Close(v8::Null());
}

/**
 * This struct contains all the data necessary to perform an wait_for_invoke request
 * using the uv_queue_worker API, which allows blocking code to be scheduled to be run on a separate
 * thread.
 */
typedef struct wait_for_invoke_work {
    //input values
    uv_work_t req; //this is used by libuv
    Persistent<Function> callback; //this is the node.js javascript callback to invoke when the worker is done
    //return values
    int rc; // if non-zero, the initialization failed
    int _errno; //set to something meaningful when rc is non-zero
    int runtime_uninitialized;
    int data_sock;
    char invokeid[INVOKE_ID_SIZE];
    awscredentials creds;
    char json_event_body[LAMBDA_EVENT_BODY_SIZE];
} wait_for_invoke_work;

static void wait_for_invoke_do(uv_work_t* req)
{
    int rc = 0;
    wait_for_invoke_work *work = (wait_for_invoke_work *)req->data;
    //TODO clean up by dis-entangling runtime initialization from receive_start
    if(!__runtime) {
        work->rc = -1;
        work->_errno = ENOENT;
        return;
    }

    rc = runtime_recv_invoke(__runtime, work->invokeid, &work->creds, &work->data_sock, work->json_event_body, sizeof(work->json_event_body));

    if(rc) {
        work->rc = -1;
        work->_errno = errno;
        work->runtime_uninitialized = 1;
    } else {
        work->rc = 0;
        work->_errno = 0;
        work->runtime_uninitialized = 0;
    }
}

/**
 * this function gets called by uv in a separate thread, after init_runtime_do has been called.
 */
static void post_wait_for_invoke_do(uv_work_t* req, int status) {
    HandleScope scope;
    wait_for_invoke_work *work = (wait_for_invoke_work *)req->data;
    Handle<Value> argv[1] = {Undefined()};

    if(work->rc) {
        if(work->runtime_uninitialized) {
            argv[0] = Exception::Error(String::New(RUNTIME_ERROR_UNINITIALIZED));
        } else {
            argv[0] = ErrnoException(work->_errno, "WaitForInvokeNb");
        }
    } else {
        Handle<Object> credentials = Object::New();
        credentials->Set(String::New("key"), String::New(work->creds.key));
        credentials->Set(String::New("secret"), String::New(work->creds.secret));
        credentials->Set(String::New("session"), String::New(work->creds.session));

        Handle<Object> object = Object::New();
        object->Set(String::New("invokeid"), String::New(work->invokeid));
        object->Set(String::New("sockfd"), Integer::New(work->data_sock));
        object->Set(String::New("credentials"), credentials);
        object->Set(String::New("eventbody"), String::New(work->json_event_body));

        argv[0] = object;
    }

    //invoke the javascript callback function, either with an exception or with the receive_start data
    node::MakeCallback(Context::GetCurrent()->Global(),
            work->callback,
            1,
            argv);

    //TODO do we need to worry about C++ exceptions here?
    work->callback.Dispose();
    work->callback.Clear();
    free(work);
}

/**
 * wait for invoke asynchronously.
 * Arguments are:
 *  the control socket (int)
 *  a callback to invoke when function finishes (function)
 */
static Handle<Value> WaitForInvokeNb(const Arguments& args)
{
    HandleScope scope;
    wait_for_invoke_work *work;

    if(!args[0]->IsFunction()) {
        return TYPE_ERROR(RUNTIME_ERROR_INVALID_ARGS);
    }

    work = (wait_for_invoke_work *)calloc(1, sizeof(work[0]));
    work->req.data = work;
    work->callback = Persistent<Function>::New(args[0].As<Function>());
    uv_queue_work(uv_default_loop(), &work->req, wait_for_invoke_do, post_wait_for_invoke_do);
    return Undefined();
}

/**
 * Sends the console logs to the logger process.
 */
static Handle<Value> SendConsoleLogs(const Arguments& args)
{
    if (args.Length() < 1) {
        return TYPE_ERROR(RUNTIME_ERROR_INVALID_ARGS);
    }

    String::Utf8Value console_log(args[0]);
    runtime_send_console_message(__runtime, *console_log);

    return Undefined();
}

static Handle<Value> InitRuntime(const Arguments& args)
{
    HandleScope scope;
    Handle<Value> startData;

    startData = ReceiveStart();
    return scope.Close(startData);
}

void Initialize(v8::Handle<v8::Object> exports)
{
    if(runtime_init()) {
        exit(-1);
    }
    exports->Set(String::NewSymbol("report_running"),
        FunctionTemplate::New(ReportRunning)->GetFunction());
    exports->Set(String::NewSymbol("report_done"),
        FunctionTemplate::New(ReportDone)->GetFunction());
    exports->Set(String::NewSymbol("report_fault"),
        FunctionTemplate::New(ReportFault)->GetFunction());
    exports->Set(String::NewSymbol("init_runtime"),
        FunctionTemplate::New(InitRuntime)->GetFunction());
    exports->Set(String::NewSymbol("wait_for_invoke_nb"),
        FunctionTemplate::New(WaitForInvokeNb)->GetFunction());
    exports->Set(String::NewSymbol("send_console_logs"),
        FunctionTemplate::New(SendConsoleLogs)->GetFunction());
}

}  // namespace awslambda

NODE_MODULE(awslambda, awslambda::Initialize)
