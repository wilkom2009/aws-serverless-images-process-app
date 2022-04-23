const {
  Stack,
  aws_codepipeline: codepipeline,
  aws_codepipeline_actions: codepipeline_actions,
  SecretValue,
} = require("aws-cdk-lib");
const { StringParameter } = require("aws-cdk-lib/aws-ssm");
const {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
} = require("aws-cdk-lib/pipelines");
const {
  AwsServerlessImagesProcessAppPipelineStage,
} = require("./aws-serverless-images-process-app-pipeline-stage");

class AwsServerlessImagesProcessAppPipelineStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    const sourceArtifact = new codepipeline.Artifact();
    const cloudAssemblyArtifact = new codepipeline.Artifact();

    const githubOwner = StringParameter.fromStringParameterAttributes(
      this,
      "gitOwner",
      {
        parameterName: "aws-serverless-images-process-app-git-owner",
      }
    ).stringValue;

    const githubRepo = StringParameter.fromStringParameterAttributes(
      this,
      "gitRepo",
      {
        parameterName: "aws-serverless-images-process-app-git-repo",
      }
    ).stringValue;

    const githubBranch = StringParameter.fromStringParameterAttributes(
      this,
      "gitBranch",
      {
        parameterName: "aws-serverless-images-process-app-git-branch",
      }
    ).stringValue;

    const pipeline = new CodePipeline(this, "Pipeline", {
      crossAccountKeys: false,
      cloudAssemblyArtifact,
      // Define application source
      sourceAction: new codepipeline_actions.GitHubSourceAction({
        actionName: "GitHub",
        output: sourceArtifact,
        oauthToken: SecretValue.secretsManager("GithubToken"), // this token is stored in Secret Manager
        owner: githubOwner,
        repo: githubRepo,
        branch: githubBranch,
      }),
      synth: new ShellStep("Synth", {
        sourceArtifact,
        cloudAssemblyArtifact,
        installCommands: "npm run build",
        commands: ["npm run cdk synth"],
      }),
      // Define build and synth commands
      // synthAction: SimpleSynthAction.standardNpmSynth({
      //   sourceArtifact,
      //   cloudAssemblyArtifact,
      //   buildCommand:
      //     "rm -rf ./reklayer/* && wget https://awsdevhour.s3-accelerate.amazonaws.com/pillow.zip && unzip pillow.zip && mv ./python ./reklayer && rm pillow.zip && npm run build",
      //   synthCommand: "npm run cdk synth",
      // }),
    });

    //Define application stage
    const stage = pipeline.addApplicationStage(
      new AwsServerlessImagesProcessAppPipelineStage(this, "dev")
    );

    // stage.addActions(new ManualApprovalAction({
    //   actionName: 'ManualApproval',
    //   runOrder: stage.nextSequentialRunOrder(),
    // }));
  }
}

module.exports = { AwsServerlessImagesProcessAppPipelineStack };
