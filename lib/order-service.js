// EN: Compatibility exports preserve existing adapters while workflow services own complete transactions.
// FI: Yhteensopivuusviennit säilyttävät nykyiset sovittimet, kun työnkulkupalvelut omistavat kokonaiset transaktiot.
module.exports = {
  submitOrder: require("./order-submission-service").submitOrder,
  transitionOrder: require("./order-transition-service").transitionOrder,
  settleOrders: require("./order-settlement-service").settleOrders,
  settleCounterOrder: require("./order-settlement-service").settleCounterOrder,
  counterOrderPrebill: require("./counter-order-service").counterOrderPrebill,
  listSentCounterOrders: require("./counter-order-service")
    .listSentCounterOrders,
  getSentCounterOrder: require("./counter-order-service").getSentCounterOrder,
  cancelSentCounterOrder: require("./counter-order-service")
    .cancelSentCounterOrder,
  settleTableSession: require("./order-settlement-service").settleTableSession,
  createAndSettleCounterOrder: require("./counter-order-service")
    .createAndSettleCounterOrder,
  quoteCounterDraft: require("./counter-order-service").quoteCounterDraft,
  replayCounterKitchenSubmission: require("./counter-order-service")
    .replayCounterKitchenSubmission,
  draftBillLines: require("./counter-order-service").draftBillLines,
  checkoutCounterDraft: require("./counter-order-service").checkoutCounterDraft,
  normalizeCounterDraftIntent: require("./counter-order-service")
    .normalizeCounterDraftIntent,
};
