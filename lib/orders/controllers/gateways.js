var _ = require("underscore"), checkout = require("./checkout"), mailing = require("mailing");

var createGateway = exports.createGateway = function(type) {
  return new require("../gateways/" + type.toLowerCase()).gateway;
}

exports.puntopagos = {};

exports.puntopagos.notify_post = function(req, res) {
  // TODO: check when this get's invoked and it's use

  // Example of Body from PuntoPagos
  // { codigo_autorizacion: '281172',
  //   error: null,
  //   fecha_aprobacion: '2013-02-15T20:38:50',
  //   medio_pago: '3',
  //   medio_pago_descripcion: 'WebPay Transbank',
  //   monto: 600000,
  //   num_cuotas: 0,
  //   numero_operacion: '0963465050',
  //   numero_tarjeta: '6623',
  //   primer_vencimiento: null,
  //   respuesta: '00',
  //   tipo_cuotas: 'Sin Cuotas',
  //   tipo_pago: null,
  //   token: 'MIA64OSEA3DI076D',
  //   trx_id: '1360963315917',
  //   valor_cuota: 0
  // }

  if (req.body.error) {
    winston.error("Notify post error:", req.body);
    res.end("There has been an error: " + req.body.error);
  }
  res.end("Everythin's ok.");
}

exports.puntopagos.success = function(req, res) {
  if (!req.session.order) {
    res.redirect('/cart');
  };
  var Order = require("orders").models.Order;
  Order.findById(req.session.order, function(err, order) {
    if (err)
      throw new Error(err)
    var payment = _.first(order.payments);
    payment.status.push({
      name : "charged",
      timestamp : new Date()
    });
    payment.provider.data.push(req.body);
    order.markModified("payments");
    checkout.createDeliveries(req.session.customerData, order, function(err, deliveries) {
      if (err)
        throw new Error(err)
      winston.info("About to push deliveries and save order");
      var saveOrder = _.after(deliveries.length, function(err) {
        order.status.push({
          name : "placed",
          timestamp : new Date()
        });
        order.save(function(err, order) {
          winston.info("About to render checkout");
          if (err)
            throw new Error(err)
          else
            notifyAndRender(order, req.session.customer, res)
        });
      });
      _.each(deliveries, function(delivery) {
        delivery.orders.push(order);
        delivery.save(saveOrder);
      });
    });
  });
};

exports.puntopagos.failure = function(req, res) {
  if (!req.session.order) {
    res.redirect('/cart');
  };
  var Order = require("orders").models.Order;
  Order.findById(req.session.order, function(err, order) {
    var payment = _.first(order.payments);
    payment.status.push({
      name : "rejected",
      timestamp : new Date()
    });
    payment.provider.data.push(req.body);
    order.status.push({
      name : "canceled",
      timestamp : new Date()
    });
    order.markModified("payments");
    order.save(function(err) {
      if (err)
        throw new Error(err);
      else
        res.render("error", {
          error : req.body.error
        });
    });
  });
};

exports.bitcoin = {};

exports.bitcoin.confirm = function(req, res) {
  var secret = req.query.secret;
  var customerData = {
    customer_delivery_from : req.query.from,
    customer_delivery_to : req.query.to
  };
  winston.info("Starting bitcoin transfer confirmation.");
  if (process.env.BTCSECRET != secret) {
    winston.info("Invalid Secret", process.env.BTCSECRET );
    res.send(500, "Invalid Secret");
  } else {
    if (req.query.confirmations > 6) {
      winston.info("Got Enough Confirmations");
      var Order = require("orders").models.Order;
      Order.findById(req.params.order, function(err, order) {
        if (err)
          throw new Error(err);
        var payment = _.first(order.payments);
        if(payment == undefined) throw new Error("undefined payment", order);
        payment.provider.data.push(req.query);
        var satoshi = parseInt(req.query.value);
        var btc = satoshi / 100000000;
        var total = parseInt(_.first(payment.provider.data).total);
        var payed = _.reduce(payment.provider.data, function(memo, data){ return memo + (parseInt(data.value) || 0); }, 0);
        winston.info("Satoshi: ", satoshi);
        winston.info("btc: ", btc);
        winston.info("total: ", total);
        winston.info("payed: ", payed);
        order.markModified("payments");
        var confirmOrder = function() {
          checkout.createDeliveries(customerData, order, function(err, deliveries) {
            if (err)
              throw new Error(err);
            winston.info("About to push deliveries and save order");
            var saveOrder = _.after(deliveries.length, function(err) {
              order.status.push({
                name : "placed",
                timestamp : new Date()
              });
              order.save(function(err, order) {
                winston.info("About to render checkout");
                if (err)
                  throw new Error(err);
                else {
                  checkout.sendNotifications(order);
                  res.send("*ok*");
                };
              });
            });
            _.each(deliveries, function(delivery) {
              delivery.orders.push(order);
              delivery.save(saveOrder);
            });
          });
        };
        if (payed == total) {
          confirmOrder();
        } else {
          var Account = require("auth").models.Account;
          Account.findById(req.params.customer, function(err, customer) {
            if (err)
              throw new Error(err);
            if (total > payed) {
              var payment_obj = {
                customer : customer.toObject(),
                order : {
                  id : order._id,
                  grandTotal : (total - payed) / 100000000,
                  currency : "BTC"
                },
                btcaddress : req.query.input_address
              };
              var paymentMailOptions = {
                from : "Farm Shares Support <support@farmshares.com>", // sender address
                cco : ["support@farmshares.com", "tomas@viralzr.com"], // loopback address
                to : customer.email, // list of receivers
                subject : "Realiza el pago de tu pedido de FarmShares.com" // Subject line
              };
              winston.info("Unsuficient or exeeded payment");
              order.save(function(err){
                mailing.queueEmail(paymentMailOptions, "btcpayment", payment_obj);
                res.send("*Not there yet*");
              });
            } else {
              var refund_obj = {
                customer : customer.toObject(),
                order : {
                  id : order._id,
                  currency : "BTC"
                },
                refund : (payed - total) / 100000000
              };
              var refundMailOptions = {
                from : "Farm Shares Support <support@farmshares.com>", // sender address
                cco : ["support@farmshares.com", "tomas@viralzr.com"], // loopback address
                to : customer.email, // list of receivers
                subject : "Gracias por tu apoyo en FarmShares.com" // Subject line
              };
              mailing.queueEmail(refundMailOptions, "btcrefundpayment", refund_obj);
              confirmOrder();
            }
            
          });
        }
      });
    } else {
      winston.info("Not Enough Confirmations");
      res.send("*Not enough confirmations*");
    }
      
  }
};

exports.bitcoin.exchange = function(req, res) {
  var btcGateway = createGateway("bitcoin");

  btcGateway.to_btc(req.body.currency, req.body.amount, function(btcamount) {
    res.json({
      btc : btcamount
    });
  });
};
