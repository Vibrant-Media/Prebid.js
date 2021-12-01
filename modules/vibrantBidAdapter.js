/*
 * Vibrant Media Ltd.
 *
 * Prebid Adapter for sending bid requests to the Vibrant Prebid Server and bid responses back to the Prebid client
 *
 * Note: Only BANNER and VIDEO are currently supported by the Vibrant Prebid Server.
 */

import {logError, logInfo} from '../src/utils.js';
import {Renderer} from '../src/Renderer.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {BANNER, NATIVE, VIDEO} from '../src/mediaTypes.js';
import {OUTSTREAM} from '../src/video.js';

const BIDDER_CODE = 'vibrantmedia';
const VIBRANT_PREBID_URL = 'https://prebid.intellitxt.com';
const VIBRANT_VAST_PLAYER = 'vibrant-player';
const SUPPORTED_MEDIA_TYPES = [BANNER, NATIVE, VIDEO];

/**
 * Returns whether the given bid request contains at least one supported media request, which has valid data. (We can
 * ignore invalid/unsupported ones, as they will be filtered out by the prebid server.)
 *
 * @param {*} bidRequest the bid requests sent by the Prebid API.
 *
 * @return {boolean} true if the given bid request contains at least one supported media request with valid details,
 *                   otherwise false.
 */
const areValidSupportedMediaTypesPresent = function(bidRequest) {
  const mediaTypes = Object.keys(bidRequest.mediaTypes);

  return mediaTypes.some(function(mediaType) {
    if (mediaType === BANNER) {
      return true;
    } else if (mediaType === VIDEO) {
      return (bidRequest.mediaTypes[VIDEO].context === OUTSTREAM);
    } else if (mediaType === NATIVE) {
      return !!bidRequest.mediaTypes[NATIVE].image;
    }

    return false;
  });
};

/**
 * Returns a new outstream video renderer for the given bidder response.
 * @param {{}} bid the bid to create the renderer for.
 * @returns {Renderer} a new renderer for the given bid.
 */
const getNewRenderer = function(bid) {
  const addOutstreamRenderer = function() {
    // TODO: This needs to be evaluated. Do we need it? If so, the properties aren't sent by the server
    bid.renderer.push(function() {
      window[VIBRANT_VAST_PLAYER].setAdUnit({
        vast_tag: bid.vastTag,
        ad_unit_code: bid.requestId, // Video renderer div id
        width: bid.width || bid.meta.width,
        height: bid.height || bid.meta.height,
        progressBar: bid.meta.progressBar,
        progress: (bid.meta.progressBar) ? bid.meta.progress : 0,
        loop: bid.meta.loop || false,
        inread: bid.meta.inread || false
      });
    });
  };

  const renderer = Renderer.install({
    id: bid.creativeId,
    url: bid.meta.mpuSrc,
    loaded: false
  });

  try {
    renderer.setRender(addOutstreamRenderer);
  } catch (err) {
    logError('Pre-bid failed while creating new outstream renderer', err);
  }

  return renderer;
};

/**
 * Augments the given ad bid with any additional data required for the media type.
 *
 * @param {*} bid                the bid object to augment.
 * @param {*} serverResponseBody the Vibrant Prebid Server response body containing the bid.
 *
 * @return {void}
 */
const augmentBidWithRequiredData = {
  [BANNER]: function(bid, serverResponseBody) {
    bid.adResponse = serverResponseBody;
  },
  [VIDEO]: function(bid, serverResponseBody) {
    const newRenderer = getNewRenderer(bid);

    bid.renderer = newRenderer;
    bid.adResponse = serverResponseBody;
  },
  [NATIVE]: function(bid, serverResponseBody) {
    bid.adResponse = serverResponseBody;
  }
};

/**
 * Returns whether the given URL contains just a domain, and not (for example) a subdirectory or query parameters.
 * @param {string} url the URL to check.
 * @returns {boolean} whether the URL contains just a domain.
 */
const isBaseUrl = function(url) {
  const urlMinusScheme = url.substring(url.indexOf('://') + 3);
  const endOfDomain = urlMinusScheme.indexOf('/');
  return (endOfDomain === -1) || (endOfDomain === (urlMinusScheme.length - 1));
};

/**
 * Returns transformed bid requests that are in a format native to the Vibrant Prebid Server.
 *
 * @param {*[]} bidRequests the bid requests sent by the Prebid API.
 *
 * @returns {*[]} the transformed bid requests.
 */
const transformBidRequests = function(bidRequests) {
  const transformedBidRequests = [];

  bidRequests.forEach(function(bidRequest) {
    const transformedBidRequest = {
      code: bidRequest.adUnitCode || bidRequest.code,
      id: bidRequest.bidId || bidRequest.transactionId,
      bidder: bidRequest.bidder,
      mediaTypes: bidRequest.mediaTypes,
      bids: bidRequest.bids,
      sizes: bidRequest.sizes
    };

    transformedBidRequests.push(transformedBidRequest);
  });

  return transformedBidRequests;
};

/** @type {BidderSpec} */
export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: SUPPORTED_MEDIA_TYPES,

  /**
   * Transforms the 'raw' bid params into ones that this adapter can use, prior to creating the bid request.
   *
   * @param {object} bidParams the params to transform.
   *
   * @returns {object} the bid params.
   */
  transformBidParams: function(bidParams) {
    return bidParams;
  },

  /**
   * Determines whether or not the given bid request is valid. For all bid requests passed to the buildRequests
   * function, each will have been passed to this function and this function will have returned true.
   *
   * @param {object} bid the bid params to validate.
   *
   * @return {boolean} true if this is a valid bid, otherwise false.
   * @see SUPPORTED_MEDIA_TYPES
   */
  isBidRequestValid: function(bid) {
    const areBidRequestParamsValid = !!(bid.params.placementId || (bid.params.member && bid.params.invCode));
    return areBidRequestParamsValid && areValidSupportedMediaTypesPresent(bid);
  },

  /**
   * Return prebid server request data from the list of bid requests.
   *
   * @param {BidRequest[]}  validBidRequests an array of bids validated via the isBidRequestValid function.
   * @param {BidderRequest} bidderRequest    an object with data common to all bid requests.
   *
   * @return ServerRequest Info describing the request to the prebid server.
   */
  buildRequests: function(validBidRequests, bidderRequest) {
    const transformedBidRequests = transformBidRequests(validBidRequests);

    var url = window.parent.location.href;

    if ((window.self === window.top) && (!url || (url.substr(0, 4) !== 'http') || isBaseUrl(url))) {
      url = document.URL;
    }

    url = encodeURIComponent(url);

    const prebidData = {
      url,
      gdpr: bidderRequest.gdprConsent,
      window: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      biddata: transformedBidRequests,
    };

    return {
      method: 'POST',
      url: VIBRANT_PREBID_URL,
      data: JSON.stringify(prebidData)
    };
  },

  /**
   * Translate the Kormorant prebid server response into a list of bids.
   *
   * @param {ServerResponse} serverResponse a successful response from the server.
   * @param {BidRequest}     bidRequest     the original bid request associated with this response.
   *
   * @return {Bid[]} an array of bids returned by the server, translated into the expected Prebid.js format.
   */
  interpretResponse: function(serverResponse, bidRequest) {
    const serverResponseBody = serverResponse.body;
    const bids = serverResponseBody.bids;

    bids.forEach(function(bid) {
      augmentBidWithRequiredData[bid.mediaType](bid, serverResponseBody);
    });

    return bids;
  },

  /**
   * Called if the Prebid API gives up waiting for a prebid server response.
   *
   * Example timeout data:
   *
   * [{
   *   "bidder": "example",
   *   "bidId": "51ef8751f9aead",
   *   "params": {
   *     ...
   *   },
   *   "adUnitCode": "div-gpt-ad-1460505748561-0",
   *   "timeout": 3000,
   *   "auctionId": "18fd8b8b0bd757"
   * }]
   *
   * @param {{}} timeoutData data relating to the timeout.
   */
  onTimeout: function(timeoutData) {
    logError('Timed out waiting for bids: ' + JSON.stringify(timeoutData));
  },

  /**
   * Called when a bid returned by the Vibrant Bidder Service is successful.
   *
   * Example bid won data:
   *
   * {
   *   "bidder": "example",
   *   "width": 300,
   *   "height": 250,
   *   "adId": "330a22bdea4cac",
   *   "mediaType": "banner",
   *   "cpm": 0.28
   *   "ad": "...",
   *   "requestId": "418b37f85e772c",
   *   "adUnitCode": "div-gpt-ad-1460505748561-0",
   *   "size": "350x250",
   *   "adserverTargeting": {
   *     "hb_bidder": "example",
   *     "hb_adid": "330a22bdea4cac",
   *     "hb_pb": "0.20",
   *     "hb_size": "350x250"
   *   }
   * }
   *
   * @param {*} bidData the data associated with the won bid. See example above for data format.
   */
  onBidWon: function(bidData) {
    logInfo('Bid won: ' + JSON.stringify(bidData));
  }
};

registerBidder(spec);
