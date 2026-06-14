const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(express.json());
app.use(cors());

// Agente HTTPS para ignorar o bloqueio de certificado autoassinado (Resolve o erro da IP.TV)
const agentInseguroIPTV = new https.Agent({  
    rejectUnauthorized: false
});

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    if (!user || !senha) {
        return res.status(400).json({ error: 'RA e senha são obrigatórios.' });
    }

    try {
        const browserHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        };

        // Gerando identificadores de telemetria falsos, simulando o comportamento do app oficial mapeado no IP.TV.txt
        const idRastreio = Math.random().toString(16).substring(2, 18) + Math.random().toString(16).substring(2, 18);
        const idSessao = Math.random().toString(16).substring(2, 18);
        const traceparentFake = `00-${idRastreio}-${idSessao}-01`;
        const requestIdFake = `|${idRastreio}.${idSessao}`;

        // ==========================================================
        // [LOG #2] LOGIN SED - AUTENTICAÇÃO PRIMÁRIA
        // ==========================================================
        const loginResponse = await axios.post(
            'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken',
            { user, senha },
            {
                headers: {
                    ...browserHeaders,
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
                    'X-Product-Name': 'SalaDoFuturo',
                    'Content-Type': 'application/json'
                }
            }
        );

        let tokenLongoSED = loginResponse.data.token;
        const dadosUsuario = loginResponse.data.DadosUsuario;

        if (!tokenLongoSED || !dadosUsuario || !dadosUsuario.CD_USUARIO) {
            return res.status(401).json({ error: 'Falha na leitura dos dados de autenticação da SED.' });
        }

        // LIMPEZA SUPREMA DO TOKEN: Remove espaços, quebras de linha e limpa totalmente a string
        tokenLongoSED = tokenLongoSED.toString().replace(/[\r\n]/g, "").trim();
        if (tokenLongoSED.toLowerCase().startsWith('bearer ')) {
            tokenLongoSED = tokenLongoSED.substring(7).trim();
        }

        const tokenFinalComBearer = `Bearer ${tokenLongoSED}`;

        // Definição das variáveis de ID
        const codigoAluno9Digitos = dadosUsuario.CD_USUARIO.toString().trim(); 
        const codigoAluno8Digitos = codigoAluno9Digitos.slice(0, -1);

        console.log(`[BFF] Sessão Iniciada -> Aluno 9D: ${codigoAluno9Digitos} | Aluno 8D: ${codigoAluno8Digitos}`);

        // Headers exatos e espelhados com a telemetria do app oficial
        const sedAuthHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
            'X-Product-Name': 'SalaDoFuturo',
            'Authorization': tokenFinalComBearer,
            'Request-Id': requestIdFake,
            'traceparent': traceparentFake
        };

        // Inicialização de variáveis de retorno
        let infoEscola = {};
        let escolaId = 0;
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalAvaliacoes = 0;

        // ==========================================================
        // [LOG #10] REGISTRO DE TOKEN CMSP
        // ==========================================================
        try {
            await axios.post(
                'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/cmspwebservice/api/sala-do-futuro-alunos/registrar-usuario-token',
                {
                    userId: codigoAluno9Digitos,
                    deviceToken: "",
                    typeDeviceToken: "DESKTOP"
                },
                { headers: sedAuthHeaders }
            );
            console.log('[BFF] Token registrado com sucesso no barramento CMSP.');
        } catch (e) {
            console.warn('Erro no registro CMSP:', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #3] CONSULTA DE TURMA (SED)
        // ==========================================================
        try {
            const dadosEscolares = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${codigoAluno8Digitos}`, 
                { headers: sedAuthHeaders }
            );
            if (dadosEscolares.data && dadosEscolares.data[0]) {
                infoEscola = dadosEscolares.data[0];
                escolaId = infoEscola.CodigoEscola || 0;
            }
        } catch (e) {
            console.error('Erro na rota #3 (Turma):', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #4] CONSULTA DE BIMESTRES (SED)
        // ==========================================================
        try {
            if (escolaId > 0) {
                await axios.get(
                    `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/Bimestre/ListarBimestres?escolaId=${escolaId}`,
                    { headers: sedAuthHeaders }
                );
            }
        } catch (e) {
            console.error('Erro na rota #4 (Bimestres):', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #5] HANDSHAKE E TAREFAS (IP.TV) - Injetando Agente TLS Especial
        // ==========================================================
        try {
            const iptvTokenResponse = await axios.post(
                'https://edusp-api.ip.tv/registration/edusp/token',
                { token: tokenLongoSED }, 
                {
                    httpsAgent: agentInseguroIPTV, // Força a passar pelo certificado self-signed sem quebrar
                    headers: {
                        'Host': 'edusp',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                        'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
                    }
                }
            );

            const auth_token_iptv = iptvTokenResponse.data.auth_token;

            if (auth_token_iptv) {
                const iptvDataHeaders = {
                    'Host': 'edusp',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'x-api-key': auth_token_iptv 
                };

                const pendenciasResponse = await axios.get(
                    'https://edusp-api.ip.tv/tms/task/todo/count?filter_expired=true&publication_target=vialv', 
                    { 
                        httpsAgent: agentInseguroIPTV, // Mantém o bypass no endpoint de dados
                        headers: iptvDataHeaders 
                    }
                );
                tarefasPendentes = pendenciasResponse.data.todo || 0;
                tarefasExpiradas = pendenciasResponse.data.expired || 0;
            }
        } catch (e) {
            console.error('Erro na integração IP.TV:', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #28] CONSULTA DE AVALIAÇÕES (SED)
        // ==========================================================
        try {
            const avaliacoesResponse = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${codigoAluno8Digitos}&AnoLetivo=2026`, 
                { headers: sedAuthHeaders }
            );
            if (Array.isArray(avaliacoesResponse.data)) {
                totalAvaliacoes = avaliacoesResponse.data.length;
            }
        } catch (e) {
            console.error('Erro na rota #28 (Avaliações):', e.response?.data || e.message);
        }

        // Devolve os dados limpos ao cliente
        res.json({
            aluno: {
                codigo: codigoAluno8Digitos,
                escola: infoEscola.NomeEscola || 'Não Informada',
                turma: infoEscola.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: 0
            }
        });

    } catch (error) {
        console.error('Erro crítico no barramento principal:', error.message);
        res.status(500).json({ error: 'Erro ao processar dados no servidor administrativo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Blindado e Habilitado para TLS ativo na porta ${PORT}`));
