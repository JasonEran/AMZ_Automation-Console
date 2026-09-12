import { e, makeEnv } from './dom-stub.js';

/**
 * Fixtures modelled on the real Account Health page: a "Policy Compliance" card
 * whose heading sits next to a status pill, with the Account Health Rating shown
 * as a large number above a 0/100/200/1000 axis. The axis ticks are the trap the
 * score extractor has to avoid, so they are present in every fixture.
 */

const BIG = { fontSize: '28px', fontWeight: '700' };
const H = { fontSize: '20px', fontWeight: '700' };
const PILL = { fontSize: '13px', fontWeight: '600' };
const TICK = { fontSize: '11px', fontWeight: '400' };

/** @param {string} pill status text shown in the badge @param {number} score AHR */
export function accountHealthDom(pill, score, { pillAttrs = {}, extraNoise = [] } = {}) {
  return e(
    'body', {}, {},
    e('div', { id: 'nav' }, {}, e('span', {}, {}, 'Seller Central'), e('span', {}, {}, 'Orders'), e('span', {}, {}, 'Advertising')),
    e(
      'div', { class: 'ah-card' }, {},
      e(
        'div', { class: 'ah-card-head' }, {},
        e('h2', {}, H, 'Policy Compliance'),
        e('kat-status', { variant: pill === 'Healthy' ? 'success' : 'warning', ...pillAttrs }, PILL, pill),
      ),
      e(
        'div', { class: 'ah-card-body' }, {},
        e(
          'div', { class: 'ah-left' }, {},
          e('h3', {}, { fontSize: '16px', fontWeight: '700' }, 'Account Health Rating'),
          e('p', {}, { fontSize: '13px' }, "This rating reflects your adherence to Amazon's selling policies."),
          e('a', { href: '#' }, { fontSize: '13px' }, 'Learn more'),
        ),
        e(
          'div', { class: 'ah-right' }, {},
          e('span', { class: 'ahr-score' }, BIG, String(score)),
          e(
            'div', { class: 'ahr-axis' }, {},
            e('span', {}, TICK, '0'),
            e('span', {}, TICK, '100'),
            e('span', {}, TICK, '200'),
            e('span', {}, TICK, '1000'),
          ),
        ),
      ),
    ),
    e('div', { class: 'other-card' }, {}, e('h2', {}, H, 'Shipping Performance'), e('span', {}, PILL, 'Good')),
    ...extraNoise,
  );
}

/** Simplified Chinese rendering observed on live Seller Central accounts. */
export function accountHealthDomZh(score = 344) {
  return e(
    'body', {}, {},
    e('div', { id: 'nav' }, {}, e('span', {}, {}, '亚马逊卖家平台'), e('span', {}, {}, '账户状况')),
    e(
      'div', { class: 'ah-card' }, {},
      e('div', { class: 'ah-card-head' }, {},
        e('h2', {}, H, '政策合规性'),
        e('kat-status', { variant: 'success' }, PILL, '良好'),
      ),
      e('div', { class: 'ah-card-body' }, {},
        e('div', {}, {},
          e('h3', {}, { fontSize: '16px', fontWeight: '700' }, '账户状况评级'),
          e('p', {}, {}, '此评级反映了您对亚马逊销售政策的遵循程度。'),
        ),
        e('div', {}, {},
          e('span', { class: 'ahr-score' }, BIG, String(score)),
          e('div', {}, {}, e('span', {}, TICK, '0'), e('span', {}, TICK, '100'), e('span', {}, TICK, '200'), e('span', {}, TICK, '1000')),
        ),
      ),
    ),
    e('div', {}, {}, e('h2', {}, H, '配送绩效')),
  );
}

/**
 * The real trap, taken from a live probe: Seller Central's header carries its own
 * account-health pill ("Fun Toys LLC United States Healthy"). On a 404 page the
 * Policy Compliance card is absent but that pill is present, so any page-wide
 * scan reports HEALTHY for a store it never actually read.
 */
export function notFoundWithNavHealthPill() {
  return e(
    'body', {}, {},
    e('div', { id: 'nav-header' }, {},
      e('span', {}, {}, 'Seller Central'),
      e('span', {}, {}, 'Fun Toys LLC'),
      e('span', {}, {}, 'United States'),
      e('span', { class: 'nav-ah-pill' }, { fontSize: '14px', fontWeight: '700' }, 'Healthy'),
      e('span', {}, {}, 'Account Health'),
      e('span', {}, {}, 'Feedback Manager'),
    ),
    e('div', { id: 'body' }, {},
      e('h1', {}, { fontSize: '20px' }, 'Page not found'),
      e('p', {}, {}, "The requested URL doesn't exist. Please check your URL and try again."),
    ),
  );
}

export function loginDom() {
  return e(
    'body', {}, {},
    e('h1', {}, H, 'Amazon Sign-In'),
    e('label', {}, {}, 'Email or mobile phone number'),
    e('input', { type: 'password' }, {}),
    e('a', {}, {}, 'Forgot your password?'),
  );
}

export function envFor(body, href) {
  return makeEnv(body, { href: href || 'https://sellercentral.amazon.com/performance/dashboard/accounthealth' });
}

// ---- page-text fixtures (Path B: `page content --content-format text`) ----

export const TEXT_HEALTHY = `
Seller Central Orders Advertising Reports
Account Health
Customer Service Performance
Order Defect Rate 0.15% Healthy
Policy Compliance Healthy
Account Health Rating
256
This rating reflects your adherence to Amazon's selling policies. Learn more.
0 100 200 1000
Shipping Performance Good
`;

export const TEXT_AT_RISK = `
Account Health
Policy Compliance At Risk
Account Health Rating
120
This rating reflects your adherence to Amazon's selling policies. Learn more.
0 100 200 1000
`;

export const TEXT_HEALTHY_ZH = `
亚马逊卖家平台 账户状况 客户服务绩效 商品政策合规性 配送绩效
政策合规性 良好
账户状况评级
344
此评级反映了您对亚马逊销售政策的遵循程度。
0 100 200 1000
所有问题 涉嫌侵犯知识产权 0 上架政策违规 0
`;

export const TEXT_LOGIN = `
Amazon Sign-In
Email or mobile phone number
Password Forgot your password?
Sign in
`;

export const TEXT_BLOCKED = `
Robot Check
Enter the characters you see below
Sorry, we just need to make sure you're not a robot.
`;

/** Card present but the status word is missing — must NOT be read as healthy. */
export const TEXT_NO_STATUS = `
Account Health
Policy Compliance
Account Health Rating
256
0 100 200 1000
`;

/** "at risk" appears far from the card; must not flip the Policy Compliance verdict. */
export const TEXT_HEALTHY_WITH_DECOY = `
Account Health
Notice: 3 of your listings are at risk of suppression. Review them in Manage Inventory.
${'filler text to push the decoy well outside the 260-character window. '.repeat(8)}
Policy Compliance Healthy
Account Health Rating
310
0 100 200 1000
`;

/**
 * Verbatim excerpt from a live probe of the real Account Health page
 * (/performance/dashboard). Note the header's own "Healthy" pill appears far
 * earlier in the text than the card's — the anchored parser must pick the
 * card's, and the score must be 256, not one of the axis ticks.
 */
export const TEXT_REAL_XCAI = `Menu Products Workspace Manage products Account health Manage account health Site map Seller Central Fun Toys LLC United States Healthy Manage All Inventory FBA Inventory Account Health Feedback Manager Performance Notifications Customer Reviews A+ Content Manager Campaign Manager Account Health Performance Notifications X Account health Manage account health Account Health Customer Service Performance Product Policy Compliance Shipping Performance Reports Eligibilities Voice of the Customer Account Health Leave Feedback To sell on Amazon, you must adhere to the below performance targets and policies. Customer Service Performance Seller Fulfilled Fulfilled by Amazon Order Defect Rate Target: under 1% N/A 0% 0 of 1,273 orders 60 days View details Policy Compliance Healthy Account Health Rating This rating reflects your adherence to Amazon's selling policies. Learn more. 256 0 100 200 1000 All Issues Suspected Intellectual Property Violations 0 Listing Policy Violations 0 View all (0) Shipping Performance Seller Fulfilled Late Shipment Rate Target: under 4% N/A View details`;
