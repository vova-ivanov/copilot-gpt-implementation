import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// --- Pulumi ESC: Secrets/config would be referenced here ---
// In practice, you would use `pulumi.config.getSecret` or ESC environment variables.
// For this program, we'll use Pulumi config as a stand-in for ESC.
const config = new pulumi.Config();
const openaiApiKey = config.requireSecret("openaiApiKey"); // ESC: OpenAI API Key
const googleClientId = config.requireSecret("googleClientId"); // ESC: Google OAuth Client ID
const googleClientSecret = config.requireSecret("googleClientSecret"); // ESC: Google OAuth Client Secret

// --- 1. S3 Bucket for Frontend ---
const siteBucket = new aws.s3.BucketV2("chatgpt-frontend", {
    forceDestroy: true,
});

// Set the website configuration using a separate resource
const siteBucketWebsite = new aws.s3.BucketWebsiteConfigurationV2("chatgpt-frontend-website", {
    bucket: siteBucket.id,
    indexDocument: { suffix: "index.html" },
    errorDocument: { key: "error.html" },
});

const publicReadPolicyForBucket = siteBucket.id.apply(bucketName => JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
        Effect: "Allow",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucketName}/*`],
    }],
}));

const publicAccessBlock = new aws.s3.BucketPublicAccessBlock("chatgpt-frontend-public-access-block", {
    bucket: siteBucket.id,
    blockPublicAcls: false,
    blockPublicPolicy: false,
    ignorePublicAcls: false,
    restrictPublicBuckets: false,
});

const bucketPolicy = new aws.s3.BucketPolicy("chatgpt-frontend-policy", {
    bucket: siteBucket.id,
    policy: publicReadPolicyForBucket,
}, { dependsOn: [publicAccessBlock] }); // <-- Add this line

// --- 2. CloudFront Distribution for S3 Website ---
const originId = "s3-site-origin";
const cdn = new aws.cloudfront.Distribution("chatgpt-cdn", {
    enabled: true,
    origins: [{
        domainName: siteBucketWebsite.websiteEndpoint,
        originId,
        customOriginConfig: {
            originProtocolPolicy: "http-only",
            httpPort: 80,
            httpsPort: 443,
            originSslProtocols: ["TLSv1.2"],
        },
    }],
    defaultRootObject: "index.html",
    defaultCacheBehavior: {
        targetOriginId: originId,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            queryString: false,
            cookies: { forward: "none" },
        },
    },
    priceClass: "PriceClass_100",
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        cloudfrontDefaultCertificate: true,
    },
});

// --- 3. Cognito User Pool (with Google IdP) ---
const userPool = new aws.cognito.UserPool("chatgpt-userpool", {
    name: "chatgpt-userpool",
    autoVerifiedAttributes: ["email"],
    aliasAttributes: ["email"],
    adminCreateUserConfig: {
        allowAdminCreateUserOnly: false,
    },
    passwordPolicy: {
        minimumLength: 8,
        requireNumbers: true,
        requireSymbols: false,
        requireLowercase: true,
        requireUppercase: true,
    },
});


const googleIdp = new aws.cognito.IdentityProvider("google-idp", {
    userPoolId: userPool.id,
    providerName: "Google",
    providerType: "Google",
    providerDetails: {
        client_id: googleClientId,
        client_secret: googleClientSecret,
        authorize_scopes: "openid email profile",
    },
    attributeMapping: {
        email: "email",
        given_name: "given_name",
        family_name: "family_name",
    },
});

const userPoolClient = new aws.cognito.UserPoolClient("chatgpt-userpool-client", {
    userPoolId: userPool.id,
    generateSecret: false,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["openid", "email", "profile"],
    allowedOauthFlowsUserPoolClient: true,
    supportedIdentityProviders: ["COGNITO", googleIdp.providerName],
    callbackUrls: [cdn.domainName.apply(domain => `https://${domain}/callback`)],
    logoutUrls: [cdn.domainName.apply(domain => `https://${domain}/logout`)],
    explicitAuthFlows: [
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_PASSWORD_AUTH",
    ],
});

// --- 4. DynamoDB Table for Conversations ---
const chatTable = new aws.dynamodb.Table("chatgpt-chats", {
    name: "chatgpt-chats",
    attributes: [
        { name: "userId", type: "S" },
        { name: "chatId", type: "S" },
    ],
    hashKey: "userId",
    rangeKey: "chatId",
    billingMode: "PAY_PER_REQUEST",
    pointInTimeRecovery: { enabled: true },
    serverSideEncryption: { enabled: true },
});

// --- 5. IAM Role for Lambda ---
const lambdaRole = new aws.iam.Role("chatgpt-lambda-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "lambda.amazonaws.com",
    }),
});

new aws.iam.RolePolicyAttachment("lambda-basic-exec", {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
});
new aws.iam.RolePolicyAttachment("lambda-dynamodb-access", {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicies.AmazonDynamoDBFullAccess,
});

// --- 6. Lambda Function (API) ---
const lambda = new aws.lambda.Function("chatgpt-backend", {
    runtime: "nodejs18.x",
    role: lambdaRole.arn,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
const AWS = require('aws-sdk');
const https = require('https');
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
    // Parse event for route, user, etc.
    // This is a placeholder for chat logic, OpenAI proxy, etc.
    // Use process.env.OPENAI_API_KEY for OpenAI API calls.
    // Use DynamoDB for storing/retrieving chats.
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ChatGPT backend placeholder' })
    };
};
        `),
    }),
    environment: {
        variables: {
            OPENAI_API_KEY: openaiApiKey,
            TABLE_NAME: chatTable.name,
        },
    },
    timeout: 30,
    memorySize: 512,
});

// --- 7. API Gateway (HTTP API) ---
const api = new aws.apigatewayv2.Api("chatgpt-api", {
    protocolType: "HTTP",
    name: "chatgpt-api",
    corsConfiguration: {
        allowOrigins: ["*"] ,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["*"],
        allowCredentials: false,
    },
});

const integration = new aws.apigatewayv2.Integration("chatgpt-api-integration", {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationUri: lambda.arn,
    payloadFormatVersion: "2.0",
});

const route = new aws.apigatewayv2.Route("chatgpt-api-route", {
    apiId: api.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
});

const stage = new aws.apigatewayv2.Stage("chatgpt-api-stage", {
    apiId: api.id,
    name: "$default",
    autoDeploy: true,
});

// Grant API Gateway permission to invoke Lambda
new aws.lambda.Permission("apigw-lambda-permission", {
    action: "lambda:InvokeFunction",
    function: lambda.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
});

// --- Outputs ---
export const frontendUrl = cdn.domainName.apply(domain => `https://${domain}`);
export const apiEndpoint = api.apiEndpoint;
export const cognitoUserPoolId = userPool.id;
export const cognitoClientId = userPoolClient.id;
