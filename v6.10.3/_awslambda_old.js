/**
 * Simulates the features offered by the natives AWS Lambda
 * Currently, only provides skeletons to avoid crashing the lambda
 * Doesn't implement anything at this point
 */
module.exports = {
  /**
   * probably used to set singletons/cache, to know when the lambda started probably?
   * may be used to implement getRemainingTime
   */
  initRuntime: function () {
    const crypto = require("crypto");
    const id = crypto.randomBytes(16).toString("hex");

    return {
      invokeid: '52fdfc07-2182-154f-163f-5f0f9a621d72',
      credentials: {

      },
      handler: function () {

      },
      suppressInit: function () {

      }
    }
  },
  reportRunning: function (invokeid) {

  },
  getRemainingTime: function () {
    return 30000; // TODO
  },
  reportUserInvokeStart: function () {

  },
  reportUserInvokeEnd: function () {

  },
  reportUserInitStart: function () {

  },
  reportUserInitEnd: function () {

  },
  reportException: function (err) {

  },
  reportFault: function (invokeid, msg, name, stack) {

  },
  reportDone: function (invokeid, result0, result1, fatal) {

  },
  waitForInvoke: function (start) {

  },
  sendConsoleLogs: function(message, bufferedMessage){

  },
  maxLoggedErrorSize: 10000, // TODO no idea what value it's supposed to be
}
