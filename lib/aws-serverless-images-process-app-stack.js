const {
  Stack,
  Duration,
  CfnOutput,
  RemovalPolicy,
  aws_s3: s3,
  aws_lambda: lambda,
  aws_lambda_event_sources: event_sources,
  aws_dynamodb: dynamodb,
  aws_iam: iam,
  aws_apigateway: apigw,
  aws_cognito: cognito,
  aws_s3_deployment: s3deploy,
  aws_sqs: sqs,
  aws_s3_notifications: s3n,
} = require("aws-cdk-lib");
const {
  PassthroughBehavior,
  AuthorizationType,
} = require("aws-cdk-lib/aws-apigateway");
const { HttpMethods } = require("aws-cdk-lib/aws-s3");

const imageBucketName = "aws-srvls-imgpro-imagebucket";
const resizedBucketName = imageBucketName + "-resized";
const websiteBucketName = "aws-srvls-imgpro-publicbucket";

class AwsServerlessImagesProcessAppStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    //===============================
    // Component 1 : Image bucket
    //===============================
    // Image bucket
    const imageBucket = new s3.Bucket(this, imageBucketName, {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const imageBucketArn = imageBucket.bucketArn;
    //Create Cloudformation output with id key:imageBucket and value:created bucket name
    new CfnOutput(this, "rawImageBucket", {
      value: imageBucket.bucketName,
    });
    imageBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000,
    });

    //===============================
    // Component 2 : Thumbnail bucket
    //===============================
    // Image bucket
    const imageResizedBucket = new s3.Bucket(this, resizedBucketName, {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const imageResizedBucketArn = imageResizedBucket.bucketArn;
    //Create Cloudformation output with id key:imageBucket and value:created bucket name
    new CfnOutput(this, "resizedImageBucket", {
      value: imageResizedBucket.bucketName,
    });
    imageResizedBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000,
    });

    // =====================================================================================
    // Construct to create our Amazon S3 Bucket to host our website
    // =====================================================================================
    const webBucket = new s3.Bucket(this, websiteBucketName, {
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
      removalPolicy: RemovalPolicy.DESTROY,
      publicReadAccess: true,
    });

    // webBucket.addToResourcePolicy(
    //   new iam.PolicyStatement({
    //     actions: ["s3:GetObject"],
    //     resources: [webBucket.arnForObjects("*")],
    //     principals: [new iam.AnyPrincipal()],
    //     conditions: {
    //       IpAddress: {
    //         "aws:SourceIp": [
    //           "*.*.*.*/*", // Please change it to your IP address or from your allowed list
    //         ],
    //       },
    //     },
    //   })
    // );
    new CfnOutput(this, "bucketURL", {
      value: webBucket.bucketWebsiteDomainName,
    });

    // =====================================================================================
    // Deploy site contents to S3 Bucket
    // =====================================================================================
    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [s3deploy.Source.asset("./public")],
      destinationBucket: webBucket,
    });

    //===============================
    // Component 3 : DynamoDb table for storing image labels
    //===============================
    const table = new dynamodb.Table(this, "ImageLabels", {
      partitionKey: { name: "image", type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new CfnOutput(this, "imagesLabelsTable", {
      value: table.tableName,
    });

    // =====================================================================================
    // AWS Lambda Function layer
    // =====================================================================================
    const layer = new lambda.LayerVersion(this, "pil", {
      code: lambda.Code.fromAsset("reklayer"),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
      license: "Apache-2.0",
      description:
        "A layer to enable the PIL library in our Rekognition Lambda",
    });

    //==============================================================================================================================
    // Component 4 : AWS Lambda function to pull images from bucket, process it through Rekognition and put it into resized bucket
    //==============================================================================================================================
    const rekFn = new lambda.Function(this, "rekognitionFunction", {
      code: lambda.Code.fromAsset("rekognitionlambda"),
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "index.handler",
      timeout: Duration.seconds(30),
      memorySize: 1024,
      layers: [layer],
      environment: {
        TABLE: table.tableName,
        BUCKET: imageBucket.bucketName,
        RESIZEDBUCKET: imageResizedBucket.bucketName,
      },
    });

    // now rekFn get event from SQS, reason why comment instruction below
    // rekFn.addEventSource(
    //   new event_sources.S3EventSource(imageBucket, {
    //     events: [s3.EventType.OBJECT_CREATED],
    //   })
    // );
    imageBucket.grantRead(rekFn); // Function needs to READ resized images from this bucket
    imageResizedBucket.grantPut(rekFn); // Function needs to PUT resized images in this bucket
    table.grantWriteData(rekFn); // Function needs to WRITE images info in this table

    rekFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["rekognition:DetectLabels"],
        resources: ["*"],
      })
    );

    // ===================================================================================
    // Component 6 : AWS Lambda for Synchronous API Gateway
    // =================================================================================
    const serviceFn = new lambda.Function(this, "serviceFunction", {
      code: lambda.Code.fromAsset("servicelambda"),
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "index.handler",
      environment: {
        TABLE: table.tableName,
        BUCKET: imageBucket.bucketName,
        RESIZEDBUCKET: imageResizedBucket.bucketName,
      },
    });

    imageBucket.grantWrite(serviceFn);
    imageResizedBucket.grantWrite(serviceFn);
    table.grantReadWriteData(serviceFn);

    const api = new apigw.LambdaRestApi(this, "imageAPI", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
      },
      handler: serviceFn,
      proxy: false,
    });

    // =====================================================================================
    // This construct builds a new Amazon API Gateway with AWS Lambda Integration
    // =====================================================================================
    const lambdaIntegration = new apigw.LambdaIntegration(serviceFn, {
      proxy: false,
      requestParameters: {
        "integration.request.querystring.action":
          "method.request.querystring.action",
        "integration.request.querystring.key": "method.request.querystring.key",
      },
      requestTemplates: {
        "application/json": JSON.stringify({
          action: "$util.escapeJavaScript($input.params('action'))",
          key: "$util.escapeJavaScript($input.params('key'))",
        }),
      },
      passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES,
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            // We can map response parameters
            // - Destination parameters (the key) are the response parameters (used in mappings)
            // - Source parameters (the value) are the integration response parameters or expressions
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
        {
          // For errors, we check if the error message is not empty, get the error data
          selectionPattern: "(\n|.)+",
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
      ],
    });

    // =====================================================================================
    // Cognito User Pool Authentication
    // =====================================================================================
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true, // Allow users to sign up
      autoVerify: { email: true }, // Verify email addresses by sending a verification code
      signInAliases: { username: true, email: true }, // Set email as an alias
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false, // Don't need to generate secret for web app running on browsers
    });

    const identityPool = new cognito.CfnIdentityPool(
      this,
      "ImageRekognitionIdentityPool",
      {
        allowUnauthenticatedIdentities: false, // Don't allow unathenticated users
        cognitoIdentityProviders: [
          {
            clientId: userPoolClient.userPoolClientId,
            providerName: userPool.userPoolProviderName,
          },
        ],
      }
    );

    const auth = new apigw.CfnAuthorizer(this, "APIGatewayAuthorizer", {
      name: "customer-authorizer",
      identitySource: "method.request.header.Authorization",
      providerArns: [userPool.userPoolArn],
      restApiId: api.restApiId,
      type: AuthorizationType.COGNITO,
    });

    const authenticatedRole = new iam.Role(
      this,
      "ImageRekognitionAuthenticatedRole",
      {
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": identityPool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "authenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    // IAM policy granting users permission to upload, download and delete their own pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        effect: iam.Effect.ALLOW,
        resources: [
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
          imageResizedBucketArn +
            "/private/${cognito-identity.amazonaws.com:sub}/*",
          imageResizedBucketArn +
            "/private/${cognito-identity.amazonaws.com:sub}",
        ],
      })
    );

    // IAM policy granting users permission to list their pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        effect: iam.Effect.ALLOW,
        resources: [imageBucketArn, imageResizedBucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"],
          },
        },
      })
    );

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      "IdentityPoolRoleAttachment",
      {
        identityPoolId: identityPool.ref,
        roles: { authenticated: authenticatedRole.roleArn },
      }
    );

    // Export values of Cognito
    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new CfnOutput(this, "AppClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, "IdentityPoolId", {
      value: identityPool.ref,
    });

    //======================================================
    // Component 7 : Api Gateway to expose backend endpoints
    //======================================================
    const imageAPI = api.root.addResource("images");

    // GET /images
    imageAPI.addMethod("GET", lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        "method.request.querystring.action": true,
        "method.request.querystring.key": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
      ],
    });

    // DELETE /images
    imageAPI.addMethod("DELETE", lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        "method.request.querystring.action": true,
        "method.request.querystring.key": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
      ],
    });

    // =====================================================================================
    // Building SQS queue and DeadLetter Queue
    // =====================================================================================
    const dlQueue = new sqs.Queue(this, "ImageDLQueue", {
      queueName: "ImageDLQueue",
    });

    const queue = new sqs.Queue(this, "ImageQueue", {
      queueName: "ImageQueue",
      visibilityTimeout: Duration.seconds(30),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 2,
        queue: dlQueue,
      },
    });

    // =====================================================================================
    // Building S3 Bucket Create Notification to SQS
    // =====================================================================================
    imageBucket.addObjectCreatedNotification(new s3n.SqsDestination(queue), {
      prefix: "private/",
    });

    // =====================================================================================
    // Lambda(Rekognition) to consume messages from SQS
    // =====================================================================================
    rekFn.addEventSource(new event_sources.SqsEventSource(queue));
  }
}

module.exports = { AwsServerlessImagesProcessAppStack };
