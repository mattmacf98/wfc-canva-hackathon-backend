import express, { CookieOptions } from 'express';
import cookieParser from 'cookie-parser';
import crypto from "node:crypto";
import dotenv from 'dotenv';
import cors from "cors";
import * as jose from "jose";
import { Database } from './database';
import multer from "multer";
import {ENV_TO_FRONTEND_HOST, ENV_TO_REDIRECT_URL} from "./config";

dotenv.config();
const frontendHost = ENV_TO_FRONTEND_HOST[String(process.env.NODE_ENV)];
const redirectUrl = ENV_TO_REDIRECT_URL[String(process.env.NODE_ENV)];
const app = express();
app.use(cors({
    origin: [frontendHost],
    credentials: true
}))
app.use(cookieParser(process.env.DATABASE_ENCRYPTION_KEY));
const port = 3001;
const OAUTH_CODE_VERIFIER_COOKIE_NAME = "ocv";
const AUTH_COOKIE_NAME = "aut";
const database: Database = new Database();
const storage = multer.memoryStorage();
const upload = multer({storage});


app.get("/authorize", async (req, res) => {
    const codeVerifier = crypto.randomBytes(96).toString("base64url");
    const state = crypto.randomBytes(96).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest().toString("base64url");

    const scopes = [
        "asset:read",
        "asset:write",
        "brandtemplate:content:read",
        "brandtemplate:meta:read",
        "comment:read",
        "comment:write",
        "design:content:read",
        "design:content:write",
        "design:meta:read",
        "design:permission:read",
        "design:permission:write",
        "folder:read",
        "folder:write",
        "folder:permission:read",
        "folder:permission:write",
        "profile:read",
    ];
    const scopeString = scopes.join(" ");
    const clientId = process.env.CANVA_CLIENT_ID;

    const url = new URL(`https://www.canva.com/api/oauth/authorize`);
    url.searchParams.append("code_challenge", codeChallenge);
    url.searchParams.append("code_challenge_method", "S256");
    url.searchParams.append("scope", scopeString);
    url.searchParams.append("response_type", "code");
    url.searchParams.append("client_id", clientId!);
    url.searchParams.append("state", state);
    url.searchParams.append("redirect_uri", redirectUrl)

    const cookieConfiguration: CookieOptions = {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 20, // 20 minutes
        sameSite: "lax", // since we will be redirecting back from Canva, we need the cookies to be sent with every request to our domain
        secure: process.env.NODE_ENV === "production",
        signed: true,
    };

    return (
        res
            .cookie(
                OAUTH_CODE_VERIFIER_COOKIE_NAME,
                codeVerifier,
                cookieConfiguration,
            )
            .redirect(url.toString())
    );
});

app.get("/oauth/redirect", async (req, res) => {
    const authorizationCode = req.query.code;
    const codeVerifier = req.signedCookies[OAUTH_CODE_VERIFIER_COOKIE_NAME];

    const url = "https://api.canva.com/rest/v1/oauth/token";
    const authCredentials = `Basic ${Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString("base64")}`;


    const params = new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode!.toString(),
        code_verifier: codeVerifier,
        redirect_uri: redirectUrl
    });

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": authCredentials,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
        });

        if (!response.ok) {
            throw new Error(`HTTP Error! status: ${response.status}`);
        }

        const data: any = await response.json();

        const claims = jose.decodeJwt(data["access_token"]);
        const claimsSub = claims.sub;

        res.cookie(AUTH_COOKIE_NAME, claimsSub, {
            httpOnly: true,
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
            secure: process.env.NODE_ENV === "production", // true for prod
            signed: true
        });

        database.setToken(claimsSub!, data["access_token"]);

        return res.redirect("/success");
    } catch (err) {
        console.log('Error fetching OAuth Token', err);
    }
})

app.get("/folder", async (req, res) => {
    const { folderId } = req.query;
    const authToken = database.getToken(req.signedCookies[AUTH_COOKIE_NAME])

    let result;
    try {
        result = await fetch(`https://api.canva.com/rest/v1/folders/${folderId}/items`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${authToken}`,
            },
        });
    } catch (error: any) {
        return res.status(400).send(error.message);
    }


    const data: any = await result.json();
    if (data.code === "invalid_access_token"){
        return res.status(400).send({error: data.message});
    }

    const assetData: any = data["items"].filter((entry: any) => entry["type"] === "asset").map((entry: any) => {
        const asset: any = entry["asset"]
        return {
            id: asset["id"],
            name: asset["name"],
            url: asset["thumbnail"]["url"]
        }
    });

    const folderData: any = data["items"].filter((entry: any) => entry["type"] === "folder").map((entry: any) => {
        const folder: any = entry["folder"]
        return {
            id: folder["id"],
            name: folder["name"]
        }
    });

    return res.send({assets: assetData, folders: folderData})
})

app.get("/success", (req, res) => {
    res.send("<p>Success</p>");
})

const encode = (str: string):string => Buffer.from(str, 'binary').toString('base64');
const sleep = async (ms: number): Promise<void> => {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

app.post('/upload', upload.single('image'), async (req, res) => {
    const {name} = req.query
    if (!name) {
        return res.status(400).send("Missing param name")
    }

    const authToken = database.getToken(req.signedCookies[AUTH_COOKIE_NAME])
    try {
        const file = req.file;

        if (!file) {
            res.status(400).send("No file uploaded");
            return;
        }

        const nameB64 = encode(name as string)
        const response = await fetch("https://api.canva.com/rest/v1/asset-uploads", {
            method: "POST",
            headers: {
                "Asset-Upload-Metadata": JSON.stringify({ "name_base64": nameB64 }),
                "Authorization": `Bearer ${authToken}`,
                "Content-Type": "application/octet-stream"
            },
            body: file.buffer
        });

        const data: any = await response.json();

        let statusResponse: any = await (await fetch(`https://api.canva.com/rest/v1/asset-uploads/${data.job.id}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${authToken}`,
            },
        })).json();

        while (statusResponse.job.status === "in_progress") {
            await sleep(1000);
            statusResponse = await (await fetch(`https://api.canva.com/rest/v1/asset-uploads/${data.job.id}`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${authToken}`,
                },
            })).json();
        }

        if (statusResponse.job.status === "failed") {
            return res.status(400).send(statusResponse.job.error.message);
        }

        res.status(200).send("file uploaded successfully")
    } catch (e: any) {
        res.status(400).send(e.message);
    }
})

database.init()
    .then(() => {
        app.listen(process.env.PORT || port, () => {
            console.log(`Server Listening on port http://127.0.0.1:${port}`);
        });
    })



