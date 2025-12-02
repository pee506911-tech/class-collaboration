import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as yaml from 'yaml';
import * as fs from 'fs';
import {
    UserSchema,
    SessionSchema,
    SlideSchema,
    ParticipantSchema,
    InteractionSchema,
    QuestionSchema,
    SessionStatusSchema,
    SlideTypeSchema
} from './index';
import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// Register Schemas
registry.register('User', UserSchema);
registry.register('Session', SessionSchema);
registry.register('Slide', SlideSchema);
registry.register('Participant', ParticipantSchema);
registry.register('Interaction', InteractionSchema);
registry.register('Question', QuestionSchema);
registry.register('SessionStatus', SessionStatusSchema);
registry.register('SlideType', SlideTypeSchema);

// Define Paths (Skeleton for now, to be expanded)
registry.registerPath({
    method: 'get',
    path: '/sessions',
    summary: 'Get all sessions',
    responses: {
        200: {
            description: 'List of sessions',
            content: {
                'application/json': {
                    schema: z.array(SessionSchema),
                },
            },
        },
    },
});

registry.registerPath({
    method: 'post',
    path: '/sessions',
    summary: 'Create a session',
    request: {
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        title: z.string(),
                        allowQuestions: z.boolean().optional(),
                        requireName: z.boolean().optional(),
                    }),
                },
            },
        },
    },
    responses: {
        201: {
            description: 'Session created',
            content: {
                'application/json': {
                    schema: SessionSchema,
                },
            },
        },
    },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

const doc = generator.generateDocument({
    openapi: '3.0.0',
    info: {
        version: '1.0.0',
        title: 'ClassColab API',
        description: 'API for ClassColab Real-time Interaction Platform',
    },
    servers: [{ url: '/api' }],
});

const yamlContent = yaml.stringify(doc);

fs.writeFileSync('../openapi.yaml', yamlContent);
console.log('OpenAPI spec generated at packages/shared/openapi.yaml');
