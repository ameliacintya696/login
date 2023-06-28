import * as exec from '@actions/exec';
import { LoginConfig } from "../common/LoginConfig";
import { ExecOptions } from '@actions/exec/lib/interfaces';
import * as core from '@actions/core';
import * as io from '@actions/io';

export class AzureCliLogin {
    loginConfig: LoginConfig;
    azPath: string;
    loginOptions: ExecOptions;
    isSuccess: boolean;

    constructor(loginConfig: LoginConfig) {
        this.loginConfig = loginConfig;
        this.loginOptions = defaultExecOptions();
        this.isSuccess = false;
    }

    async login() {
        this.azPath = await io.which("az", true);
        if (!this.azPath) {
            throw new Error("Azure CLI is not found in the runner.");
        }
        core.debug(`Azure CLI path: ${this.azPath}`);

        let output: string = "";
        const execOptions: any = {
            listeners: {
                stdout: (data: Buffer) => {
                    output += data.toString();
                }
            }
        };

        await this.executeAzCliCommand(["--version"], true, execOptions);
        core.debug(`Azure CLI version used:\n${output}`);

        this.setAzurestackEnvIfNecessary();

        await this.executeAzCliCommand(["cloud", "set", "-n", this.loginConfig.environment], false);
        console.log(`Done setting cloud: "${this.loginConfig.environment}"`);

        if (this.loginConfig.authType == "service_principal") {
            let args = ["--service-principal",
                "--username", this.loginConfig.servicePrincipalId,
                "--tenant", this.loginConfig.tenantId
            ];
            if (this.loginConfig.servicePrincipalKey) {
                await this.loginWithSecret(args);
            }
            else {
                await this.loginWithOIDC(args);
            }
        }
        else {
            let args = ["--identity"];
            if (this.loginConfig.servicePrincipalId) {
                await this.loginWithUserAssignedIdentity(args);
            }
            else {
                await this.loginWithSystemAssignedIdentity(args);
            }
        }
    }

    async setAzurestackEnvIfNecessary() {
        if (this.loginConfig.environment != "azurestack") {
            return;
        }
        if (!this.loginConfig.resourceManagerEndpointUrl) {
            throw new Error("resourceManagerEndpointUrl is a required parameter when environment is defined.");
        }

        console.log(`Unregistering cloud: "${this.loginConfig.environment}" first if it exists`);
        try {
            await this.executeAzCliCommand(["cloud", "set", "-n", "AzureCloud"], true);
            await this.executeAzCliCommand(["cloud", "unregister", "-n", this.loginConfig.environment], false);
        }
        catch (error) {
            console.log(`Ignore cloud not registered error: "${error}"`);
        }

        console.log(`Registering cloud: "${this.loginConfig.environment}" with ARM endpoint: "${this.loginConfig.resourceManagerEndpointUrl}"`);
        try {
            let baseUri = this.loginConfig.resourceManagerEndpointUrl;
            if (baseUri.endsWith('/')) {
                baseUri = baseUri.substring(0, baseUri.length - 1); // need to remove trailing / from resourceManagerEndpointUrl to correctly derive suffixes below
            }
            let suffixKeyvault = ".vault" + baseUri.substring(baseUri.indexOf('.')); // keyvault suffix starts with .
            let suffixStorage = baseUri.substring(baseUri.indexOf('.') + 1); // storage suffix starts without .
            let profileVersion = "2019-03-01-hybrid";
            await this.executeAzCliCommand(["cloud", "register", "-n", this.loginConfig.environment, "--endpoint-resource-manager", `"${this.loginConfig.resourceManagerEndpointUrl}"`, "--suffix-keyvault-dns", `"${suffixKeyvault}"`, "--suffix-storage-endpoint", `"${suffixStorage}"`, "--profile", `"${profileVersion}"`], false);
        }
        catch (error) {
            core.error(`Error while trying to register cloud "${this.loginConfig.environment}"`);
            throw error;
        }

        console.log(`Done registering cloud: "${this.loginConfig.environment}"`)
    }

    async loginWithSecret(args: string[]) {
        console.log("Note: Azure/login action also supports OIDC login mechanism. Refer https://github.com/azure/login#configure-a-service-principal-with-a-federated-credential-to-use-oidc-based-authentication for more details.")
        args.push(`--password=${this.loginConfig.servicePrincipalKey}`);
        await this.callCliLogin(args, 'service principal with secret');
    }

    async loginWithOIDC(args: string[]) {
        await this.loginConfig.getFederatedToken();
        args.push("--federated-token", this.loginConfig.federatedToken);
        await this.callCliLogin(args, 'OIDC');
    }

    async loginWithUserAssignedIdentity(args: string[]) {
        args.push("--username", this.loginConfig.servicePrincipalId);
        await this.callCliLogin(args, 'user-assigned managed identity');
    }

    async loginWithSystemAssignedIdentity(args: string[]) {
        await this.callCliLogin(args, 'system-assigned managed identity');
    }

    async callCliLogin(args: string[], methodName: string) {
        try {
            console.log(`Attempting Azure CLI login by using ${methodName}...`);
            args.unshift("login");
            if (this.loginConfig.allowNoSubscriptionsLogin) {
                args.push("--allow-no-subscriptions");
            }
            await this.executeAzCliCommand(args, true, this.loginOptions);
            await this.setSubscription();
            this.isSuccess = true;
            console.log(`Azure CLI login succeed by using ${methodName}.`);
        }
        catch (error) {
            throw new Error(`Azure CLI login failed: ${error} Please check the credentials and auth-type. For more information refer https://github.com/Azure/login#readme`);
        }
    }

    async setSubscription() {
        if (this.loginConfig.allowNoSubscriptionsLogin) {
            return;
        }
        if (!this.loginConfig.subscriptionId) {
            core.warning('No subscription-id is given. Skip setting subscription... If there are mutiple subscriptions under the tenant, please input subscription-id to specify which subscription to use.');
            return;
        }
        let args = ["account", "set", "--subscription", this.loginConfig.subscriptionId];
        await this.executeAzCliCommand(args, true, this.loginOptions);
        console.log("Subscription is set successfully.");
    }

    async executeAzCliCommand(
        args: string[],
        silent?: boolean,
        execOptions: any = {}) {
        execOptions.silent = !!silent;
        await exec.exec(`"${this.azPath}"`, args, execOptions);
    }
}

function defaultExecOptions(): exec.ExecOptions {
    return {
        silent: true,
        listeners: {
            stderr: (data: Buffer) => {
                let error = data.toString();
                let startsWithWarning = error.toLowerCase().startsWith('warning');
                let startsWithError = error.toLowerCase().startsWith('error');
                // printing ERROR
                if (error && error.trim().length !== 0 && !startsWithWarning) {
                    if (startsWithError) {
                        //removing the keyword 'ERROR' to avoid duplicates while throwing error
                        error = error.slice(5);
                    }
                    core.error(error);
                }
            }
        }
    };
}