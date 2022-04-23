import { CfnOutput, Construct, Stage, StageProps } from "@aws-cdk/core";
import { AwsServerlessImagesProcessAppStack } from "./aws-serverless-images-process-app-stack";

/**
 * Deployable unit of AwsServerlessImagesProcess app
 * */
export class AwsServerlessImagesProcessAppPipelineStage extends Stage {
  constructor(scope, id, props) {
    super(scope, id, props);

    new AwsServerlessImagesProcessAppStack(this, "AwsServerlessImagesProcessAppStack-dev");
  }
}
