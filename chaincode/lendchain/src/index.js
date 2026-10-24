'use strict';
const ParticipantRegistry = require('./registry');
const LoanContract = require('./loan');
const BidMatch = require('./bid');
const RepaymentLedger = require('./repay');

module.exports.contracts = [ParticipantRegistry, LoanContract, BidMatch, RepaymentLedger];
