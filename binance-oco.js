#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint func-names: ["warn", "as-needed"] */

require('dotenv').config();

const { argv } = require('yargs')
  .usage('Usage: $0')
  .example(
    '$0 -p BNBBTC -a 1 -b 0.002 -s 0.001 -t 0.003',
    'Place a buy order for 1 BNB @ 0.002 BTC. Once filled, place a stop-limit sell @ 0.001 BTC. If a price of 0.003 BTC is reached, cancel stop-limit order and place a limit sell @ 0.003 BTC.',
  )
  // '-p <tradingPair>'
  .demand('pair')
  .alias('p', 'pair')
  .describe('p', 'Set trading pair eg. BNBBTC')
  // '-a <amount>'
  .demand('amount')
  .number('a')
  .alias('a', 'amount')
  .describe('a', 'Set amount to buy/sell')
  // '-b <buyPrice>'
  .number('b')
  .alias('b', 'buy')
  .alias('b', 'e')
  .alias('b', 'entry')
  .describe('b', 'Set buy price (0 for market buy)')
  .number('y')
  .alias('y', 'trigger')
  .describe('y', 'Set trigger price')
  // '-s <stopPrice>'
  .number('s')
  .alias('s', 'stop')
  .describe('s', 'Set stop-limit order stop price')
  // '-l <limitPrice>'
  .number('l')
  .alias('l', 'limit')
  .describe('l', 'Set stop-limit order limit sell price (if different from stop price).')
  // '-t <targetPrice>'
  .number('t')
  .alias('t', 'target')
  .describe('t', 'Set target limit order sell price')
  // '-c <cancelPrice>'
  .number('c')
  .alias('c', 'cancel')
  .describe('c', 'Set price at which to cancel buy order')
  // '-S <scaleOutAmount>'
  .number('S')
  .alias('S', 'scaleOutAmount')
  .describe('S', 'Set amount to sell (scale out) at target price (if different from amount)');
  // '-x <testMode>'
  // .boolean('x')
  // .alias('x', 'testMode')
  // .default(false)
  // .describe('x', 'Run the client in test mode (simulate orders');

let {
  p: pair, a: amount, b: buyPrice, s: stopPrice, l: limitPrice, t: targetPrice, c: cancelPrice,
  S: scaleOutAmount, y: triggerPrice
} = argv;

pair = pair.toUpperCase();

const Binance = require('node-binance-api');
const moment = require('moment');

const binance = new Binance().options({
  APIKEY: process.env.APIKEY,
  APISECRET: process.env.APISECRET,
  useServerTime: true,
  reconnect: true,
  verbose: true,
  test: false
}, () => {
  binance.exchangeInfo((exchangeInfoError, exchangeInfoData) => {
    if (exchangeInfoError) {
      console.error('Could not pull exchange info', exchangeInfoError.body);
      process.exit(1);
    }

    const symbolData = exchangeInfoData.symbols.find(ei => ei.symbol === pair);
    if (!symbolData) {
      console.error(`Could not pull exchange info for ${pair}`);
      process.exit(1);
    }

    const { filters } = symbolData;
    const { stepSize, minQty } = filters.find(eis => eis.filterType === 'LOT_SIZE');
    const { tickSize, minPrice } = filters.find(eis => eis.filterType === 'PRICE_FILTER');
    const { minNotional } = filters.find(eis => eis.filterType === 'MIN_NOTIONAL');

    amount = binance.roundStep(amount, stepSize);

    if (scaleOutAmount) {
      scaleOutAmount = binance.roundStep(scaleOutAmount, stepSize);
    }

    if (buyPrice) {
      buyPrice = binance.roundTicks(buyPrice, tickSize);

      if (amount < minQty) {
        console.error(`Amount ${amount} does not meet minimum order amount ${minQty}.`);
        process.exit(1);
      }

      if (buyPrice < minPrice) {
        console.error(`Buy price ${buyPrice} does not meet minimum order price ${minPrice}.`);
        process.exit(1);
      }

      if (buyPrice * amount < minNotional) {
        console.error(`Buy order does not meet minimum order value ${minNotional}.`);
        process.exit(1);
      }

      if (triggerPrice) {
        triggerPrice = binance.roundTicks(triggerPrice, tickSize);
        if (triggerPrice < minPrice) {
          console.error(`Trigger price ${triggerPrice} does not meet minimum order price ${minPrice}.`);
          process.exit(1);
        }
      } else {
        // let the triggerPrice and buyPrice be the same if triggerPrice not specified.
        triggerPrice = buyPrice
      }
    }

    let stopSellAmount = amount;

    if (stopPrice) {
      stopPrice = binance.roundTicks(stopPrice, tickSize);

      if (stopSellAmount < minQty) {
        console.error(`Amount ${stopSellAmount} does not meet minimum order amount ${minQty}.`);
        process.exit(1);
      }

      if (limitPrice) {
        limitPrice = binance.roundTicks(limitPrice, tickSize);

        if (limitPrice < minPrice) {
          console.error(`Limit price ${limitPrice} does not meet minimum order price ${minPrice}.`);
          process.exit(1);
        }

        if (limitPrice * stopSellAmount < minNotional) {
          console.error(`Stop order does not meet minimum order value ${minNotional}.`);
          process.exit(1);
        }
      } else {
        if (stopPrice < minPrice) {
          console.error(`Stop price ${stopPrice} does not meet minimum order price ${minPrice}.`);
          process.exit(1);
        }

        if (stopPrice * stopSellAmount < minNotional) {
          console.error(`Stop order does not meet minimum order value ${minNotional}.`);
          process.exit(1);
        }
      }
    }

    let targetSellAmount = scaleOutAmount || amount;

    if (targetPrice) {
      targetPrice = binance.roundTicks(targetPrice, tickSize);

      if (targetSellAmount < minQty) {
        console.error(`Amount ${targetSellAmount} does not meet minimum order amount ${minQty}.`);
        process.exit(1);
      }

      if (targetPrice < minPrice) {
        console.error(`Target price ${targetPrice} does not meet minimum order price ${minPrice}.`);
        process.exit(1);
      }

      if (targetPrice * targetSellAmount < minNotional) {
        console.error(`Target order does not meet minimum order value ${minNotional}.`);
        process.exit(1);
      }
    }

    if (cancelPrice) {
      cancelPrice = binance.roundTicks(cancelPrice, tickSize);
    }

    const NON_BNB_TRADING_FEE = 0.001;

    const calculateSellAmount = function (commissionAsset, sellAmount) {
      // Adjust sell amount if BNB not used for trading fee
      return (commissionAsset === 'BNB') ? sellAmount : (sellAmount * (1 - NON_BNB_TRADING_FEE));
    };

    const calculateStopAndTargetAmounts = function (commissionAsset) {
      stopSellAmount = calculateSellAmount(commissionAsset, stopSellAmount);
      targetSellAmount = calculateSellAmount(commissionAsset, targetSellAmount);
    };

    let stopOrderId = 0;
    let targetOrderId = 0;

    const sellComplete = function (error, response) {
      if (error) {
        console.error(`${moment()}: Sell error`, error.body);
        process.exit(1);
      }

      console.log('Sell response', response);
      console.log(`order id: ${response.orderId}`);

      if (!(stopPrice && targetPrice)) {
        console.error(`${moment()}: No stop or target price - exit`);
        process.exit();
      }

      if (response.type === 'STOP_LOSS_LIMIT') {
        stopOrderId = response.orderId;
      } else if (response.type === 'LIMIT') {
        targetOrderId = response.orderId;
      }
    };

    const placeStopOrder = function () {
      // TODO: could do with automatically calculating a sensible stop loss limit otherwise stop could be skipped!
      console.log(`${moment()}: ${pair} place stop_loss_limit order for ${stopSellAmount} at ${limitPrice || stopPrice}`);
      binance.sell(pair, stopSellAmount, limitPrice || stopPrice, { stopPrice, type: 'STOP_LOSS_LIMIT', newOrderRespType: 'FULL' }, sellComplete);
    };

    const placeTargetOrder = function () {
      console.log(`${moment()}: ${pair} place target limit order for ${targetSellAmount} at ${targetPrice}`);
      binance.sell(pair, targetSellAmount, targetPrice, { type: 'LIMIT', newOrderRespType: 'FULL' }, sellComplete);
      if (stopPrice && targetSellAmount !== stopSellAmount) {
        stopSellAmount -= targetSellAmount;
        // place a stop for the remainder of the position
        placeStopOrder();
      }
    };

    const placeSellOrder = function () {
      if (stopPrice) {
        placeStopOrder();
      } else if (targetPrice) {
        placeTargetOrder();
      } else {
        console.log(`${moment}: No stop or target orders - exit.`)
        process.exit();
      }
    };

    let buyOrderId = 0;

    const buyComplete = function (error, response) {
      if (error) {
        console.error(`${moment()}: Buy error`, error.body);
        process.exit();
      }

      console.log('Buy response', response);
      console.log(`order id: ${response.orderId}`);

      if (response.status === 'FILLED') {
        calculateStopAndTargetAmounts(response.fills[0].commissionAsset);
        placeSellOrder();
      } else {
        buyOrderId = response.orderId;
      }
    };

    // determine order type
    if (triggerPrice === 0) {
      console.log(`${moment()}: ${pair} place market buy order for ${amount}`);
      binance.marketBuy(pair, amount, { type: 'MARKET', newOrderRespType: 'FULL' }, buyComplete);
    } else if (triggerPrice > 0) {
      binance.prices(pair, (error, ticker) => {
        const currentPrice = ticker[pair];
        console.log(`${pair} price: ${currentPrice}`);

        if (triggerPrice > currentPrice) {
          console.log(`${moment()}: ${pair} place buy stop_loss_limit order for ${amount} at ${triggerPrice} limit ${buyPrice}`);
          binance.buy(pair, amount, buyPrice, { stopPrice: triggerPrice, type: 'STOP_LOSS_LIMIT', newOrderRespType: 'FULL' }, buyComplete);
        } else {
          console.log(`${moment()}: ${pair} place buy limit order for ${amount} at ${buyPrice}`);
          binance.buy(pair, amount, buyPrice, { type: 'LIMIT', newOrderRespType: 'FULL' }, buyComplete);
        }
      });
    } else {
      placeSellOrder();
    }

    let isCancelling = false;

    binance.websockets.trades([pair], (trades) => {
      const { s: symbol, p: price } = trades;
      // if order is placed
      if (buyOrderId) {
        if (!cancelPrice) {
          console.log(`${moment()}: ${symbol} trade update. price: ${price} buy: ${triggerPrice}`);
        } else {
          console.log(`${moment()}: ${symbol} trade update. price: ${price} buy: ${triggerPrice} cancel: ${cancelPrice}`);

          if (((price < triggerPrice && price <= cancelPrice)
            || (price > triggerPrice && price >= cancelPrice))
            && !isCancelling) {
              console.log(`${moment()}: ${symbol} cancelling untriggered order because it moved outside the desired price range without a fill.`)
            isCancelling = true;
            binance.cancel(symbol, buyOrderId, (error, response) => {
              isCancelling = false;
              if (error) {
                console.error(`${moment()}: ${symbol} cancel error:`, error.body);
                return;
              }

              console.log(`${moment()}: ${symbol} cancel response:`, response);
              process.exit(0);
            });
          }
        }
      } else if (stopOrderId || targetOrderId) {
        console.log(`${moment()}: ${symbol} trade update. price: ${price} stop: ${stopPrice} target: ${targetPrice}`);
        if (stopOrderId && !targetOrderId && price >= targetPrice && !isCancelling) {
          isCancelling = true;
          console.log(`${moment()}: ${symbol} cancelling stop order because target price was hit.`)
          binance.cancel(symbol, stopOrderId, (error, response) => {
            isCancelling = false;
            if (error) {
              console.error(`${moment()}: ${symbol} cancel error:`, error.body);
              return;
            }

            stopOrderId = 0;
            console.log(`${moment()}: ${symbol} cancel response:`, response);
            placeTargetOrder();
          });
        } else if (targetOrderId && !stopOrderId && price <= stopPrice && !isCancelling) {
          console.log(`${moment()}: ${symbol} cancelling target order because stop price was hit.`)
          isCancelling = true;
          binance.cancel(symbol, targetOrderId, (error, response) => {
            isCancelling = false;
            if (error) {
              console.error(`${moment()}: ${symbol} cancel error:`, error.body);
              return;
            }

            targetOrderId = 0;
            console.log(`${moment()}: ${symbol} cancel response:`, response);
            // recalculate stop amount now target is gone
            if (targetSellAmount !== stopSellAmount) {
              stopSellAmount += targetSellAmount;
            }
            // there is a risk the stop loss will not be triggered if price has jumped though in this scenario
            // it would have had to hit target first.
            placeStopOrder();
          });
        }
      }
    });

    const checkOrderFilled = function (data, orderFilled) {
      const {
        s: symbol, p: price, q: quantity, S: side, o: orderType, i: orderId, X: orderStatus,
      } = data;

      console.log(`${symbol} ${side} ${orderType} ORDER #${orderId} (${orderStatus})`);
      console.log(`..price: ${price}, quantity: ${quantity}`);
      // if our order not completely filled yet then carry on
      if (orderStatus === 'NEW' || orderStatus === 'PARTIALLY_FILLED') {
        return;
      }
      // if our order not filled then something went wrong
      if (orderStatus !== 'FILLED') {
        console.error(`${moment}: Order ${orderStatus}. Reason: ${data.r}`);
        process.exit(1);
      }
      // if order filled or any other status then handle it
      orderFilled(data);
    };

    // check the orders after entry and update amounts
    binance.websockets.userData(() => { }, (data) => {
      const { i: orderId } = data;

      if (orderId === buyOrderId) {
        checkOrderFilled(data, () => {
          const { N: commissionAsset } = data;
          buyOrderId = 0;
          calculateStopAndTargetAmounts(commissionAsset);
          placeSellOrder();
        });
      } else if (orderId === stopOrderId) {
        checkOrderFilled(data, () => {
          console.log(`${moment}: Trade stopped out. Time to quit.`);
          process.exit();
        });
      } else if (orderId === targetOrderId) {
        checkOrderFilled(data, () => {
          console.log(`${moment}: Trade target hit. You still have ${stopSellAmount} left in the trade with a stop at ${stopPrice}. The trade will not be automated from this point on.`);
          process.exit();
        });
      }
    });
  });
});

process.on('exit', () => {
  console.log(`Process terminated at ${moment()}`)
  const endpoints = binance.websockets.subscriptions();
  binance.websockets.terminate(Object.entries(endpoints));
});

process.once('SIGINT', function (code) {
  console.log(`SIGINT received at ${moment()} - code ${code}`);
});


process.once('SIGTERM', function (code) {
  console.log(`SIGTERM received at ${moment()} - code ${code}` );
});

process.once('SIGHUP', function (code) {
  console.log(`SIGHUP received at ${moment()} - code ${code}` );
});
