import path from 'node:path';

export const SITE_KEYS = ['blog', 'tech'];

const SITE_PROFILES = {
  blog: {
    siteKey: 'blog',
    deployName: 'taipei',
    siteHost: 'blog.mozilla.com.tw',
    archiveDir: 'archive-blog',
    buildDir: 'blog',
    sitemapPath: 'blog/taipei',
    timemapPath: 'json-blog.json',
    wpContentPath: 'blog-wp-content.json',
    eventsDir: path.join('archive-blog', 'events'),
    themeAssetsDir: path.join('archive-blog', 'theme-assets'),
    siteTitle: 'Mozilla Taiwan 部落格',
    siteSubtitle: '最新部落格文章，提供各式 Mozilla 產品與專案相關訊息',
    siteDescription:
      '提供 Mozilla 與 Firefox、Firefox OS 的五花八門最新訊息，包括 Firefox 開發、Firefox 最新功能、Firefox 使用教學、Firefox 錯誤迷思導正、Firefox 好用附加元件訊息，以及由 Mozilla Taiwan 官方舉辦的各式 Firefox 活動訊息、新聞、部落文分享',
    hasEvents: true,
    hasAuthors: false,
    hasAuthorCardAliases: false,
  },
  tech: {
    siteKey: 'tech',
    deployName: 'tech',
    siteHost: 'tech.mozilla.com.tw',
    archiveDir: 'archive-tech',
    buildDir: 'tech',
    sitemapPath: 'blog/tech',
    timemapPath: 'json-tech.json',
    wpContentPath: 'tech-wp-content.json',
    authorsDir: path.join('archive-tech', 'authors'),
    themeAssetsDir: path.join('archive-blog', 'theme-assets'),
    siteTitle: '謀智台客',
    siteSubtitle: 'Firefox OS 研發工程師團隊共筆資料庫，提供各式 Firefox OS 開發心得與甘苦談',
    siteDescription:
      'Mozilla Tech | 謀智台客，含 Firefox、Firefox OS (B2G) 、HTML、Javascript、CSS等軟體專案之最新消息、技巧，及公告資訊。',
    hasEvents: false,
    hasAuthors: true,
    hasAuthorCardAliases: true,
  },
};

for (const profile of Object.values(SITE_PROFILES)) {
  profile.siteOrigin = `https://${profile.siteHost}`;
}

export function sitePublicBaseUrl(profile) {
  const segment = (profile.sitemapPath || profile.deployPath || profile.deployName).replace(/^\/+|\/+$/g, '');
  return `https://moztw.org/${segment}/`;
}

export function getSiteProfile(siteKey) {
  const profile = SITE_PROFILES[siteKey];
  if (!profile) {
    throw new Error(`Unknown site "${siteKey}". Expected one of: ${SITE_KEYS.join(', ')}`);
  }
  return profile;
}

export function getSiteProfiles(siteKeys = SITE_KEYS) {
  return siteKeys.map((siteKey) => getSiteProfile(siteKey));
}

export function buildSiteArgs(profile) {
  return [
    '--build-dir',
    profile.buildDir,
    '--archive-dir',
    profile.archiveDir,
    '--site-host',
    profile.siteHost,
    '--theme-assets',
    profile.themeAssetsDir,
    '--site-title',
    profile.siteTitle,
    '--site-subtitle',
    profile.siteSubtitle,
    '--site-description',
    profile.siteDescription,
    '--canonical-base',
    sitePublicBaseUrl(profile),
  ];
}

export function archiveSiteArgs(profile) {
  return [
    '--site-host',
    profile.siteHost,
    '--archive-dir',
    profile.archiveDir,
    '--timemap',
    profile.timemapPath,
    '--wp-content',
    profile.wpContentPath,
  ];
}
