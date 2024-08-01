import * as fs from "fs/promises";
import * as path from "path";
const DATABASE_FILE_PATH = path.join(__dirname, "db.json");

interface IUser {
    id: string,
    token: string
}
export class Database {
    users: IUser[];

    constructor() {
        this.users = [];
    }

    public async init() {
        try {
            const data = await fs.readFile(DATABASE_FILE_PATH, "utf8");
            this.users = JSON.parse(data);
        } catch (error: any) {
            if (error.code === "ENOENT") {
                await this.saveState();
            }
        }
    }

    public getToken(id: string): string | undefined {
        const user = this.users.find(user => user.id === id);
        return user?.token;
    }

    public setToken(id: string, token: string): void {
        const user = this.users.find(user => user.id === id);
        if (user) {
            user.token = token;
        } else {
            this.users.push({id: id, token: token});
        }
        this.saveState();
    }

    private async saveState() {
        await fs.writeFile(DATABASE_FILE_PATH, JSON.stringify(this.users, null, 2), "utf8");
    }
}
