import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// --- Pulumi ESC: Using environment variables directly ---
// Configuration values are managed through Pulumi ESC environment: copilot-gpt-implementation/chatgpt-secrets
// ESC exports these as environment variables for direct use
const openaiApiKey = pulumi.secret(process.env.OPENAI_API_KEY || ""); // From ESC environment variable
const googleClientId = process.env.GOOGLE_CLIENT_ID || ""; // From ESC environment variable
const googleClientSecret = pulumi.secret(process.env.GOOGLE_CLIENT_SECRET || ""); // From ESC environment variable

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

// Create Cognito domain for OAuth flows
const userPoolDomain = new aws.cognito.UserPoolDomain("chatgpt-userpool-domain", {
    domain: "chatgpt-userpool-oha32w4z22i",
    userPoolId: userPool.id,
});

const userPoolClient = new aws.cognito.UserPoolClient("chatgpt-userpool-client", {
    userPoolId: userPool.id,
    generateSecret: false,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["openid", "email", "profile"],
    allowedOauthFlowsUserPoolClient: true,
    supportedIdentityProviders: ["COGNITO", googleIdp.providerName],
    callbackUrls: [cdn.domainName.apply(domain => `https://${domain}`)],
    logoutUrls: [cdn.domainName.apply(domain => `https://${domain}`)],
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
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const https = require('https');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Get conversation history for a user
async function getConversationHistory(userId) {
    try {
        const response = await docClient.send(new QueryCommand({
            TableName: process.env.TABLE_NAME,
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: {
                ':userId': userId
            },
            ScanIndexForward: true // Get oldest first for chronological order
        }));
        
        return response.Items || [];
    } catch (error) {
        console.error('Error retrieving conversation history:', error);
        return [];
    }
}

// Delete all conversation history for a user
async function deleteConversationHistory(userId) {
    try {
        // First get all items for the user
        const response = await docClient.send(new QueryCommand({
            TableName: process.env.TABLE_NAME,
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: {
                ':userId': userId
            }
        }));
        
        // Delete each item
        if (response.Items && response.Items.length > 0) {
            for (const item of response.Items) {
                await docClient.send(new DeleteCommand({
                    TableName: process.env.TABLE_NAME,
                    Key: {
                        userId: item.userId,
                        chatId: item.chatId
                    }
                }));
            }
        }
        
        return true;
    } catch (error) {
        console.error('Error deleting conversation history:', error);
        return false;
    }
}

// OpenAI API integration
async function callOpenAI(message, conversationHistory = []) {
    // Build messages array with conversation history
    const messages = [
        {
            role: "system",
            content: "You are a helpful assistant. Be concise and friendly."
        }
    ];
    
    // Add conversation history
    conversationHistory.forEach(item => {
        messages.push(
            { role: "user", content: item.userMessage },
            { role: "assistant", content: item.assistantMessage }
        );
    });
    
    // Add current message
    messages.push({ role: "user", content: message });

    const data = JSON.stringify({
        model: "gpt-4.1-nano",
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
    });

    const options = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': \`Bearer \${process.env.OPENAI_API_KEY}\`,
            'Content-Length': data.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseBody = '';

            res.on('data', (chunk) => {
                responseBody += chunk;
            });

            res.on('end', () => {
                console.log('OpenAI Response Status:', res.statusCode);
                console.log('OpenAI Response Body:', responseBody);
                try {
                    const parsedResponse = JSON.parse(responseBody);
                    if (res.statusCode !== 200) {
                        console.error('OpenAI API Error:', parsedResponse);
                        resolve(\`OpenAI API Error: \${parsedResponse.error?.message || 'Unknown error'}\`);
                        return;
                    }
                    if (parsedResponse.choices && parsedResponse.choices.length > 0) {
                        resolve(parsedResponse.choices[0].message.content.trim());
                    } else {
                        console.error('No choices in OpenAI response:', parsedResponse);
                        resolve('Sorry, I could not generate a response.');
                    }
                } catch (error) {
                    console.error('Error parsing OpenAI response:', error, 'Raw body:', responseBody);
                    resolve('Sorry, I encountered an error processing your request.');
                }
            });
        });

        req.on('error', (error) => {
            console.error('Error calling OpenAI API:', error);
            resolve('Sorry, I could not connect to the AI service.');
        });

        req.write(data);
        req.end();
    });
}

exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));
    
    // Handle CORS preflight OPTIONS requests
    if (event.requestContext.http.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '86400'
            },
            body: ''
        };
    }
    
    try {
        // Parse the request body
        let body;
        if (event.body) {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        } else {
            throw new Error('No body in request');
        }
        
        const { message, userId, action } = body;
        
        // Handle reset chat history action
        if (action === 'reset') {
            const success = await deleteConversationHistory(userId || 'anonymous');
            return {
                statusCode: 200,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({ 
                    success: success,
                    message: success ? 'Chat history reset successfully' : 'Failed to reset chat history'
                })
            };
        }
        
        // Handle get chat history action
        if (action === 'getHistory') {
            const history = await getConversationHistory(userId || 'anonymous');
            
            // If no history exists, create initial welcome message
            if (history.length === 0) {
                const welcomeMessage = "Hello! I'm your AI assistant. How can I help you today?";
                const chatId = Date.now().toString();
                const timestamp = new Date().toISOString();
                
                await docClient.send(new PutCommand({
                    TableName: process.env.TABLE_NAME,
                    Item: {
                        userId: userId || 'anonymous',
                        chatId: chatId,
                        timestamp: timestamp,
                        userMessage: '', // Empty user message for initial greeting
                        assistantMessage: welcomeMessage
                    }
                }));
                
                return {
                    statusCode: 200,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    body: JSON.stringify({ 
                        history: [{
                            userId: userId || 'anonymous',
                            chatId: chatId,
                            timestamp: timestamp,
                            userMessage: '',
                            assistantMessage: welcomeMessage
                        }]
                    })
                };
            }
            
            return {
                statusCode: 200,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({ 
                    history: history
                })
            };
        }
        
        if (!message) {
            throw new Error('No message provided');
        }
        
        // Get conversation history for context
        const conversationHistory = await getConversationHistory(userId || 'anonymous');
        
        // Call OpenAI API with conversation history
        const response = await callOpenAI(message, conversationHistory);
        
        // Store conversation in DynamoDB
        const chatId = Date.now().toString();
        const timestamp = new Date().toISOString();
        
        await docClient.send(new PutCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
                userId: userId || 'anonymous',
                chatId: chatId,
                timestamp: timestamp,
                userMessage: message,
                assistantMessage: response
            }
        }));
        
        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            },
            body: JSON.stringify({ message: response })
        };
        
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
                message: 'Sorry, I encountered an error processing your request.',
                error: error.message 
            })
        };
    }
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
export const cognitoDomain = userPoolDomain.domain.apply(domain => `https://${domain}.auth.us-west-2.amazoncognito.com`);
