// Express 4 does not forward rejected handler promises by itself.
module.exports = function asyncRoute(handler) {
  return function(req, res, next) {
    return Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
};

// Traverse mounted routers once at startup. Keep Express error handlers (arity4) intact.
module.exports.protectRouter=function protectRouter(router){
 for(const layer of router.stack||[]){
  if(layer.route)protectRouter(layer.route);
  else if(layer.handle?.stack)protectRouter(layer.handle);
  if(layer.handle?.constructor.name==='AsyncFunction' && layer.handle.length<4)layer.handle=module.exports(layer.handle);
 }
};
