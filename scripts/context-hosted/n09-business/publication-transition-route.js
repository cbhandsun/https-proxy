'use strict';
const routes = Object.freeze({
  prepared: Object.freeze({ delta: 1, cancellation: false, publicTransportCompleted: false }),
  sending: Object.freeze({ delta: 2, cancellation: false, publicTransportCompleted: false }),
  'transport-finished': Object.freeze({
    delta: 3,
    cancellation: false,
    publicTransportCompleted: true,
  }),
  withdrawn: Object.freeze({ delta: 2, cancellation: true, publicTransportCompleted: false }),
  uncertain: Object.freeze({ delta: 3, cancellation: true, publicTransportCompleted: false }),
});
function publicationTransitionRoute(transition) {
  if (typeof transition !== 'string' || !Object.hasOwn(routes, transition))
    throw new Error('n09_publication_transition_rejected');
  return routes[transition];
}
module.exports = { publicationTransitionRoute };
