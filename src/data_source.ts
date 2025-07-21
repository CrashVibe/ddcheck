import * as fsa from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { Context, Logger, Model } from "koishi";
import {} from "koishi-plugin-html-renderer/src";
import {} from "koishi-plugin-bilibili-login";
import { SendFetch } from "koishi-plugin-bilibili-login/lib/API/BiliBiliAPI/";

interface API_CONFIG {
    name: string;
    url: string;
    max_pages: number;
    priority: number;
}

const API_CONFIGS: API_CONFIG[] = [
    {
        name: "biligame",
        url: "https://line3-h5-mobile-api.biligame.com/game/center/h5/user/relationship/following_list",
        max_pages: 200,
        priority: 1
    },
    {
        name: "app.biliapi.net",
        url: "https://app.biliapi.net/x/v2/relation/followings",
        max_pages: 5,
        priority: 2
    }
];

const PAGE_SIZE = 50;
class BiliBiliUserAPI extends SendFetch {
    public async getUserMedals(uid: number): Promise<any[]> {
        const url = "https://api.live.bilibili.com/xlive/web-ucenter/user/MedalWall";
        const params = new URLSearchParams({ target_id: uid.toString() });
        const response = await this.sendGet(url, params, this.returnBilibiliHeaders());
        if (response.ok) {
            const data = await response.json();
            if (data.code === 0) {
                return data.data.list || [];
            }
        }
        return [];
    }

    public async getUserBasicInfo(uid: number): Promise<UserBasicInfo> {
        const defaultInfo = { name: `用户${uid}`, face: "", follower: 0, following: 0 };

        // 主API请求：获取完整信息
        try {
            const url = "https://api.bilibili.com/x/web-interface/card";
            const params = new URLSearchParams({ mid: uid.toString() });
            const response = await this.sendGet(url, params, this.returnBilibiliHeaders());
            console.info(`请求用户信息: ${url}?${params.toString()}`);
            if (response.ok) {
                const data = await response.json();
                if (data.code === 0) {
                    const { name, face, fans: follower, attention: following } = data.data?.card || {};
                    return {
                        name: name || defaultInfo.name,
                        face: face || defaultInfo.face,
                        follower: follower || defaultInfo.follower,
                        following: following || defaultInfo.following
                    };
                }
                this.logger.warn("主API获取用户信息失败:", data.message || `错误码 ${data.code}`);
            }
        } catch (e) {
            this.logger.warn("主API请求异常:", e);
        }

        // 备用API请求：补充关注数
        try {
            const url = "https://app.biliapi.net/x/v2/relation/followings ";
            const params = new URLSearchParams({ vmid: uid.toString(), pn: "1", ps: "1" });
            const response = await this.sendGet(url, params, this.returnBilibiliHeaders());

            if (response.ok) {
                const data = await response.json();
                if (data.code === 0) {
                    defaultInfo.following = data.data?.total || 0;
                } else {
                    this.logger.warn("备用API获取关注数失败:", data.message || `错误码 ${data.code}`);
                }
            }
        } catch (e) {
            this.logger.warn("备用API请求异常:", e);
        }

        return defaultInfo;
    }

    public async getUserFollowings(ctx: Context, uid: number): Promise<number[]> {
        const sortedApis = API_CONFIGS.slice().sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
        let bestResult: number[] = [];
        let bestApiName: string | undefined;

        for (const api of sortedApis) {
            try {
                ctx.logger.debug(`尝试使用 ${api.name} API获取用户${uid}的关注列表`);
                const followings = await this.fetchAllFollowings(ctx, uid, api);
                if (!followings.length) {
                    continue;
                }

                this.logger.info(`${api.name} API成功获取${followings.length}个关注`);
                if (followings.length > bestResult.length) {
                    [bestResult, bestApiName] = [followings, api.name];
                }
                if ((api.name === "biligame" && followings.length > 1000) || followings.length >= 500) {
                    break;
                }
            } catch (e) {
                this.logger.warn(`${api.name} API失败: ${e}`);
            }
        }

        bestResult.length && bestApiName
            ? this.logger.info(`最终选择${bestApiName} API的结果，获取${bestResult.length}个关注`)
            : this.logger.error(`所有API都失败，无法获取用户${uid}的关注列表`);

        return bestResult;
    }

    async fetchAllFollowings(ctx: Context, uid: number, apiConfig: API_CONFIG): Promise<number[]> {
        let followings: number[] = [];
        let page = 1,
            consecutiveFailures = 0;
        const maxConsecutiveFailures = 3;

        while (page <= apiConfig.max_pages && consecutiveFailures < maxConsecutiveFailures) {
            try {
                const params = new URLSearchParams({
                    vmid: uid.toString(),
                    pn: page.toString(),
                    ps: PAGE_SIZE.toString()
                });
                const response = await this.sendGet(apiConfig.url, params, this.returnBilibiliHeaders());
                if (!response.ok) {
                    throw new Error(`HTTP错误: ${response.status}`);
                }

                const data = await response.json();
                if (data.code !== 0) {
                    throw new Error(data.message || `API错误码: ${data.code}`);
                }

                const pageList = data.data?.list || [];
                if (!pageList.length) {
                    this.logger.info(`${apiConfig.name} API第${page}页无数据，可能已获取完毕`);
                    break;
                }

                const pageFollowings = pageList.map((user: any) => Number(user.mid));
                followings.push(...pageFollowings);
                consecutiveFailures = 0;

                ctx.logger.debug(`${apiConfig.name} API第${page}页获取${pageFollowings.length}个关注`);
                if (pageFollowings.length < PAGE_SIZE) {
                    ctx.logger.debug(`${apiConfig.name} API第${page}页数据不满，认为已获取完毕`);
                    break;
                }
                page++;
            } catch (e) {
                consecutiveFailures++;
                ctx.logger.warn(`${apiConfig.name} API第${page}页异常: ${e}`);
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    ctx.logger.error(`${apiConfig.name} API连续异常${consecutiveFailures}次，停止请求`);
                    break;
                }
                page++;
            }
        }
        return followings;
    }
}

interface UserBasicInfo {
    name: string;
    face: string;
    follower: number;
    following: number;
}

export interface UserInfo {
    mid: string;
    name: string;
    face: string;
    fans: number;
    attention: number;
    attentions: number[];
}

export async function getUserInfo(ctx: Context, uid: number): Promise<UserInfo> {
    const sendFetch = new BiliBiliUserAPI(await ctx.BiliBiliLogin.getBilibiliAccountData());

    const defaultBasicInfo: UserBasicInfo = { name: `用户${uid}`, face: "", follower: 0, following: 0 };
    let basic_info: UserBasicInfo = defaultBasicInfo;
    let followings: number[] = [];

    const [basicResult, followsResult] = await Promise.all([
        sendFetch.getUserBasicInfo(uid),
        sendFetch.getUserFollowings(ctx, uid)
    ]);

    basic_info = basicResult ?? defaultBasicInfo;
    followings = followsResult ?? [];

    return {
        mid: String(uid),
        name: basic_info.name,
        face: basic_info.face,
        fans: basic_info.follower,
        attention: basic_info.following ?? followings.length,
        attentions: followings
    };
}

function formatColor(color: number): string {
    return `#${color.toString(16).padStart(6, "0").toUpperCase()}`;
}

function formatVtbInfo(info: any, medalDict: Record<string, any>): any {
    const name = info.uname;
    const uid = info.mid;
    let medal = undefined;
    if (medalDict[name] && medalDict[name].medal_info) {
        const medalInfo = medalDict[name].medal_info;
        medal = {
            name: medalInfo.medal_name,
            level: medalInfo.level,
            color_border: formatColor(medalInfo.medal_color_border),
            color_start: formatColor(medalInfo.medal_color_start),
            color_end: formatColor(medalInfo.medal_color_end)
        };
    }
    return { name, uid, medal };
}

export async function getMedalList(ctx: Context, uid: number): Promise<any[]> {
    const sendFetch = new BiliBiliUserAPI(await ctx.BiliBiliLogin.getBilibiliAccountData());
    return await sendFetch.getUserMedals(uid);
}
export async function renderDdcheckImage(
    userInfo: UserInfo,
    vtbList: VtbInfo[],
    medalList: any[],
    ctx: Context
): Promise<Buffer> {
    const attentions: number[] = userInfo.attentions || [];
    const follows_num = Number(userInfo.attention) || 0;
    const attentionSet = new Set(attentions);
    const vtbDict: Record<number, VtbInfo> = {};
    for (const info of vtbList) vtbDict[Number(info.mid)] = info;
    const medalDict: Record<string, any> = {};
    for (const medal of medalList) medalDict[medal.target_name] = medal;
    const vtbs = Object.entries(vtbDict)
        .filter(([uid]) => attentionSet.has(Number(uid)))
        .map(([_, info]) => formatVtbInfo(info, medalDict));
    const vtbs_num = vtbs.length;
    const percent = follows_num ? (vtbs_num / follows_num) * 100 : 0;
    const num_per_col = vtbs_num ? Math.ceil(vtbs_num / Math.ceil(vtbs_num / 100)) : 1;
    const info = {
        name: userInfo.name,
        uid: userInfo.mid,
        face: userInfo.face,
        fans: userInfo.fans,
        follows: follows_num,
        percent: `${percent.toFixed(2)}% (${vtbs_num}/${follows_num})`,
        vtbs,
        num_per_col
    };
    const templateDir = path.resolve(__dirname, "templates");
    const templatePath = path.join(templateDir, "info.ejs");
    if (!fs.existsSync(templatePath)) {
        throw new Error(`模板文件不存在: ${templatePath}`);
    }
    return await ctx.html_renderer.render_template_html_file(
        templateDir,
        "info.ejs",
        { info: info },
        {
            viewport: { width: 100, height: 100 },
            base_url: templatePath
        }
    );
}

export interface VtbInfo {
    mid: number;
    uname: string;
    [key: string]: any;
}

const VTB_LIST_URLS = [
    "https://api.vtbs.moe/v1/short",
    "https://cfapi.vtbs.moe/v1/short",
    "https://hkapi.vtbs.moe/v1/short",
    "https://kr.vtbs.moe/v1/short"
];

export async function updateVtbList(ctx: Context): Promise<void> {
    const vtbList: VtbInfo[] = [];
    for (const url of VTB_LIST_URLS) {
        try {
            const resp = await axios.get(url, { timeout: 20000 });
            const result = resp.data;
            if (!Array.isArray(result) || !result.length) {
                continue;
            }
            for (const info of result) {
                if (info.uid && info.uname) {
                    vtbList.push({ mid: Number(info.uid), uname: info.uname, ...info });
                } else if (info.mid && info.uname) {
                    vtbList.push(info);
                }
            }
            break;
        } catch (e: any) {
            if (e.code === "ECONNABORTED") {
                console.warn(`Get ${url} timeout`);
            } else {
                console.warn(`Error when getting ${url}, ignore`, e);
            }
        }
    }
    await dumpVtbList(ctx, vtbList);
}

function getVtbListPath(ctx: Context): string {
    return path.join(ctx.baseDir, "data", "ddcheck", "vtb_list.json");
}

export async function loadVtbList(ctx: Context): Promise<VtbInfo[]> {
    const VTB_LIST_PATH = getVtbListPath(ctx);
    try {
        await fsa.access(VTB_LIST_PATH);
        const raw = await fsa.readFile(VTB_LIST_PATH, "utf-8");
        return JSON.parse(raw);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("vtb列表解析错误，将重新获取");
            try {
                await fsa.unlink(VTB_LIST_PATH);
            } catch {}
        }
        return [];
    }
}

export async function dumpVtbList(ctx: Context, vtbList: VtbInfo[]): Promise<void> {
    const VTB_LIST_PATH = getVtbListPath(ctx);
    await fsa.mkdir(path.dirname(VTB_LIST_PATH), { recursive: true });
    await fsa.writeFile(VTB_LIST_PATH, JSON.stringify(vtbList, null, 4), "utf-8");
}

export async function getVtbList(ctx: Context): Promise<VtbInfo[]> {
    let vtbList = await loadVtbList(ctx);
    if (!vtbList.length) {
        await updateVtbList(ctx);
        vtbList = await loadVtbList(ctx);
    }
    return vtbList;
}
