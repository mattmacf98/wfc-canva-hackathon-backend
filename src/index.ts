import express, { CookieOptions } from 'express';
import cookieParser from 'cookie-parser';
import crypto from "node:crypto";
import dotenv from 'dotenv';
import cors from "cors";
import * as jose from "jose";
import { Database } from './database';

dotenv.config();

const app = express();
app.use(cors({
    origin: ["http://127.0.0.1:3000"],
    credentials: true
}))
app.use(cookieParser(process.env.DATABASE_ENCRYPTION_KEY));
const port = 3001;
const OAUTH_CODE_VERIFIER_COOKIE_NAME = "ocv";
const AUTH_COOKIE_NAME = "aut";
const database: Database = new Database();

app.get("/authorize", async (req, res) => {
    const codeVerifier = crypto.randomBytes(96).toString("base64url");
    const state = crypto.randomBytes(96).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest().toString("base64url");

    const scopes = [
        "asset:read",
        "asset:write",
        "brandtemplate:content:read",
        "brandtemplate:meta:read",
        "design:content:read",
        "design:content:write",
        "design:meta:read",
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
    const state = req.query.state;
    const codeVerifier = req.signedCookies[OAUTH_CODE_VERIFIER_COOKIE_NAME];

    const url = "https://api.canva.com/rest/v1/oauth/token";
    const authCredentials = `Basic ${Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString("base64")}`;


    const params = new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode!.toString(),
        code_verifier: codeVerifier
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
        console.log(claimsSub);

        res.cookie(AUTH_COOKIE_NAME, claimsSub, {
            httpOnly: true,
            sameSite: "lax", // for prod do strict
            secure: false, // true for prod
            signed: true
        });

        database.setToken(claimsSub!, data["access_token"]);

        return res.redirect("/success");
    } catch (err) {
        console.log('Error fetching OAuth Token', err);
    }
})

app.get("/user", async (req, res) => {
    const authToken = database.getToken(req.signedCookies[AUTH_COOKIE_NAME])

    const result = await fetch("https://api.canva.com/rest/v1/users/me/profile", {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${authToken}`,
        },
    });
    const data: any = await result.json();
    console.log(data);
    if (data["profile"]) {
        return res.send(data["profile"])
    }
    res.status(400).send();
});

app.get("/success", (req, res) => {
    res.send("<p>Success</p>");
})

database.init()
    .then(() => {
        app.listen(port, () => {
            console.log(`Server Listening on port http://127.0.0.1:${port}`);
        });
    })



