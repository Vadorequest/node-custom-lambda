/**
 * Simulates the features offered by the natives AWS Lambda
 * Currently, only provides skeletons to avoid crashing the lambda
 * Doesn't implement anything at this point
 */
module.exports = {
  init_runtime: function () {

  },
  report_fault: function (invokeid, message, name, stack) {

  },
  report_done: function (invokeid) {

  },
  report_running: function (invokeid) {

  },
  send_console_logs: function (message, bufferedMessage) {

  },
  wait_for_invoke_nb: function (cb) {

  },
}
