# Node.js custom runtimes for official AWS Lambda runtimes (even retired ones)

## Status

> Work in progress, not ready for production use at this time

## Getting started

Use the following ARN in your project. They are made public so that anyone can use them without any authentication.

> If you wish to own your own ARN (safer) please see the **[Publishing](#publishing)** section


## Available runtimes ready for use:

- `6.10.3`: `arn:aws:lambda:eu-west-1:035907498810:layer:nodejs610:1`

**WARNING**: Those runtimes are not yet ISO with AWS Lambda, thus meaning they do not offer exactly the same capabilities and therefore may behave differently compared to the official runtimes.
_At this time, they have a the same implementation as LambdaCI, which is different from AWS implementation even though it's really close_

Only the eu-west-1 has been released at this time, due to WIP status. All regions will eventually be published to, when the project reaches maturity.

## Motivations

> The goal of this repository is to provide custom nodejs runtimes for official AWS runtimes that have been deprecated by AWS and are no longer available.
> At the moment, only the nodejs runtimes `4.3.2`,  `6.10.3`, `8.10.?` are concerned.
>
> _The point is not to encourage developers to use deprecated versions, but to offer a fallback solution for those who can't upgrade their application yet._
>
> Also, the goal is to provide safe and reliable runtimes that won't be made unavailable by AWS in the future, 
in comparison of using the official runtimes that will eventually reach EOL and will be removed, therefore requiring a manual upgrade,
which can a real pain if not anticipated properly

## Publishing

Assuming your have `aws-cli` installed and are authenticated to an AWS account _(the `default` profile will be automatically selected from your `~/.aws/config`)_

- Fork
- `cd` in the version folder you want to release
- Run `yarn release:all` which will compile, test and release for all versions _(`npm` can be used too)_

## Inspirations

This is a fork of the great work [made by LambdaCI](https://github.com/lambci/node-custom-lambda), and [another fork implementing the node4.3 version](https://github.com/daffinity/node-custom-lambda).
