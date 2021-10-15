/*
 * Vibrant Media Ltd.
 *
 * Prebid Adapter
 *
 * NOTE: This adapter is a work in progress.
 */

import { createTrackPixelHtml, logError, logWarn } from '../src/utils.js';
import { Renderer } from '../src/Renderer.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';

const BIDDER_CODE = 'vibrantmedia';
const VIBRANT_PREBID_URL = 'https://k.intellitxt.com/prebid';
const AD_TYPE_IDS = {
  BANNER: 1,
  NATIVE: 2,
  VIDEO: 3,
};
const DEFAULT_CURRENCY = 'GBP';
const BID_TTL_SECS = 300; // 5 minutes
const VIBRANT_VAST_PLAYER = 'vibrant-player';
const SUPPORTED_MEDIA_TYPES = [BANNER, NATIVE, VIDEO];

/**
 * Returns a new outstream video renderer for the given bidder response.
 * @param {{}} bidderResponse the bid response to create the renderer for.
 * @returns {Renderer}  a new renderer for the given bidder response.
 */
const getNewRenderer = function getNewRenderer(bidderResponse) {
  const addOutstreamRenderer = function addOutstreamRenderer(bid) {
    const bidVideo = bid.adResponse.ad.video;

    bid.renderer.push(function bidRenderer() {
      window[VIBRANT_VAST_PLAYER].setAdUnit({
        vast_tag: bidVideo.vtag,
        ad_unit_code: bid.adUnitCode, // Video renderer div id
        width: bid.width,
        height: bid.height,
        progress: bidVideo.progress,
        loop: bidVideo.loop,
        inread: bidVideo.inread,
      });
    });
  };

  const renderer = Renderer.install({
    id: bidderResponse.id.prebid_id,
    url: bidderResponse.ad.video.purl,
    loaded: false,
  });

  try {
    renderer.setRender(addOutstreamRenderer);
  } catch (err) {
    logWarn('Pre-bid failed while creating new outstream renderer', err);
  }

  return renderer;
};

const addVideoDataToParsedBid = function addVideoDataToParsedBid(parsedBid, serverResponseBody) {
  const videoAd = serverResponseBody.ad.video;
  const newRenderer = getNewRenderer(serverResponseBody);

  parsedBid.vastXml = videoAd.vtag;
  parsedBid.width = videoAd.w;
  parsedBid.height = videoAd.h;
  parsedBid.renderer = newRenderer;
  parsedBid.adResponse = serverResponseBody;
  parsedBid.mediaType = VIDEO;

  parsedBid.meta.advertiserDomains.push(videoAd.adomain);
};

const addBannerDataToParsedBid = function addBannerDataToParsedBid(parsedBid, serverResponseBody) {
  const bannerAd = serverResponseBody.ad.banner;

  parsedBid.width = bannerAd.w;
  parsedBid.height = bannerAd.h;
  parsedBid.ad = bannerAd.tag;
  parsedBid.mediaType = BANNER;

  bannerAd.imps.forEach(function forEachBannerAdImpression(imp) {
    try {
      const tracker = createTrackPixelHtml(imp);
      parsedBid.ad += tracker;
    } catch (err) {
      logError('Unable to create tracking pixel for ad impression');
    }

    parsedBid.meta.advertiserDomains.push(bannerAd.adomain);
  });
};

const addNativeDataToParsedBid = function addNativeDataToParsedBid(parsedBid, serverResponseBody) {
  const nativeAds = serverResponseBody.ad.native.template_and_ads.ads;

  if (nativeAds.length === 0) {
    return;
  }

  const nativeAd = nativeAds[0];
  const assets = nativeAd.assets;

  parsedBid.mediaType = NATIVE;
  parsedBid.native = {
    title: assets.title,
    body: assets.description,
    cta: assets.cta_text,
    sponsoredBy: assets.sponsor,
    clickUrl: assets.lp_link,
    impressionTrackers: nativeAd.imps,
    privacyLink: assets.adchoice_url,
  };

  if (typeof assets.img_main !== 'undefined') {
    parsedBid.native.image = {
      url: assets.img_main,
      width: parseInt(assets.img_main_width, 10),
      height: parseInt(assets.img_main_height, 10),
    };
  }

  if (typeof assets.img_icon !== 'undefined') {
    parsedBid.native.icon = {
      url: assets.img_icon,
      width: parseInt(assets.img_icon_width, 10),
      height: parseInt(assets.img_icon_height, 10),
    };
  }

  parsedBid.meta.advertiserDomains.push(nativeAd.adomain);
};

/** @type {BidderSpec} */
export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: SUPPORTED_MEDIA_TYPES,

  /**
   * Determines whether or not the given bid request is valid. For all bid requests passed to the buildRequests
   * function, each will have been passed to this function and this function will have returned true.
   *
   * @param {BidRequest} bid the bid params to validate.
   *
   * @return boolean true if this is a valid bid, otherwise false.
   * @see SUPPORTED_MEDIA_TYPES
   */
  isBidRequestValid: function isBidRequestValid(bid) {
    return SUPPORTED_MEDIA_TYPES.includes(bid.mediaType) &&
      !!(bid.params.placementId || (bid.params.member && bid.params.invCode));
  },

  /**
   * Return prebid server request data from the list of bid requests.
   *
   * @param {validBidRequest[]} validBidRequests an array of bids that have been validated via the isBidRequestValid
   *                                             function.
   * @param {BidderRequest}     bidderRequest    an object with data common to all bid requests.
   *
   * @return ServerRequest Info describing the request to the prebid server.
   */
  buildRequests: function buildRequests(validBidRequests, bidderRequest) {
    // TODO: Include in the payload the window dimensions, language, host GDPR data and/or anything else needed

    const prebidData = {
      gdpr: bidderRequest.gdprConsent,
      window: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      biddata: validBidRequests,
    };

    return {
      method: 'POST',
      url: VIBRANT_PREBID_URL,
      data: JSON.stringify(prebidData),
    };
  },

  /**
   * Translate the Kormorant prebid server response into a list of bids.
   * @param {ServerResponse} serverResponse A successful response from the server.
   * @return {object[]} an array of bids which were nested inside the server.
   */
  interpretResponse: function interpretResponse(serverResponse /* , bidRequest */) {
    const serverResponseBody = serverResponse.body;
    const bids = serverResponseBody.bids;

    const parsedBids = [];

    bids.forEach(function forEachBid(bid) {
      console.log('BID RES: ' + JSON.stringify(bidRequest));

      const parsedBid = {
        requestId: bid.prebid_id,
        cpm: bid.price,
        creativeId: bid.creative_id,
        dealId: bid.deal_id,
        currency: bid.currency || DEFAULT_CURRENCY,
        netRevenue: true,
        ttl: BID_TTL_SECS,
        meta: {
          advertiserDomains: [], // This will be filled in later on
        },
      };

      const adTypeId = bid.ad_type;

      if (adTypeId === AD_TYPE_IDS.VIDEO) {
        addVideoDataToParsedBid(parsedBid, serverResponseBody);
      } else if (adTypeId === AD_TYPE_IDS.BANNER) {
        addBannerDataToParsedBid(parsedBid, serverResponseBody);
      } else if (adTypeId === AD_TYPE_IDS.NATIVE) {
        addNativeDataToParsedBid(parsedBid, serverResponseBody);
      } else {
        logError('Unsupported ad type id: ' + adTypeId);
      }

      parsedBids.push(parsedBid);
    });

    return parsedBids;
  },

  // Example timeout data:
  //
  // [{
  //   "bidder": "example",
  //   "bidId": "51ef8751f9aead",
  //   "params": {
  //     ...
  //   },
  //   "adUnitCode": "div-gpt-ad-1460505748561-0",
  //   "timeout": 3000,
  //   "auctionId": "18fd8b8b0bd757"
  // }]
  onTimeout: function onTimeout(timeoutData) {
    console.log('Timed out waiting for bids: ' + JSON.stringify(timeoutData));
  },

  // Example bid won data:
  //
  // {
  //   "bidder": "example",
  //   "width": 300,
  //   "height": 250,
  //   "adId": "330a22bdea4cac",
  //   "mediaType": "banner",
  //   "cpm": 0.28
  //   "ad": "...",
  //   "requestId": "418b37f85e772c",
  //   "adUnitCode": "div-gpt-ad-1460505748561-0",
  //   "size": "350x250",
  //   "adserverTargeting": {
  //     "hb_bidder": "example",
  //     "hb_adid": "330a22bdea4cac",
  //     "hb_pb": "0.20",
  //     "hb_size": "350x250"
  //   }
  // }
  onBidWon: function onBidWon(bidData) {
    console.log('Bid won: ' + JSON.stringify(bidData));
  },
};

/**
 * Register the user sync pixels which should be dropped after the auction.
 *
 * @param {SyncOptions} syncOptions Which user syncs are allowed?
 * @param {ServerResponse[]} serverResponses List of server's responses.
 * @param {{}} gdprConsent the GDPR consent choices.
 * @return {UserSync[]} the user syncs which should be dropped.
 */
export const getUserSyncs = function getUserSyncs(syncOptions, serverResponses, gdprConsent) {
  const syncs = [];

  const gdprParams =
    typeof gdprConsent.gdprApplies === 'boolean'
      ? `gdpr=${Number(gdprConsent.gdprApplies)}&gdpr_consent=${gdprConsent.consentString}`
      : `gdpr_consent=${gdprConsent.consentString}`;

  const serverResponse = serverResponses[0];
  const serverResponseBody = serverResponse.body;

  if (syncOptions.pixelEnabled && serverResponseBody.syncs) {
    serverResponseBody.syncs.forEach(function forEachPixelSync(sync) {
      syncs.push({
        type: 'image',
        url: sync + '?' + gdprParams,
      });
    });
  }

  if (syncOptions.iframeEnabled && serverResponseBody.sync_htmls) {
    serverResponseBody.sync_htmls.forEach(function forEachIframeSync(sync) {
      syncs.push({
        type: 'iframe',
        url: sync + '?' + gdprParams,
      });
    });
  }

  return syncs;
};

registerBidder(spec);
