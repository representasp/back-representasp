const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

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

        // ==========================================================
        // [#2] LOGIN SED - AUTENTICAÇÃO PRIMÁRIA
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

        const codigoAluno = dadosUsuario.CD_USUARIO; 

        // TRATAMENTO DO TOKEN: Remove a palavra "Bearer " caso a SED já a envie no texto do token
        if (tokenLongoSED.startsWith('Bearer ')) {
            tokenLongoSED = tokenLongoSED.replace('Bearer ', '');
        }

        // Montagem correta e limpa do Header de Autorização
        const sedAuthHeaders = {
            ...browserHeaders,
            'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
            'X-Product-Name': 'SalaDoFuturo',
            'Authorization': `Bearer ${tokenLongoSED}`
        };

        let infoEscola = {};
        let escolaId = 0;
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalAvaliacoes = 0;

        // ==========================================================
        // [#3] CONSULTA DE TURMA (SED)
        // ==========================================================
        try {
            const dadosEscolares = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${codigoAluno}`, 
                { headers: sedAuthHeaders }
            );
            if (dadosEscolares.data && dadosEscolares.data[0]) {
                infoEscola = dadosEscolares.data[0];
                escolaId = infoEscola.CodigoEscola || 0;
            }
        } catch (e) {
            // Imprime o erro real no painel do Render para sabermos por que a rota #3 falhou
            console.error('Erro na rota #3 (Turma):', e.response?.data || e.message);
        }

        // ==========================================================
        // [#4] CONSULTA DE BIMESTRES (SED)
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
        // [#5] HANDSHAKE IP.TV
        // ==========================================================
        try {
            const iptvTokenResponse = await axios.post(
                'https://edusp-api.ip.tv/registration/edusp/token',
                { token: tokenLongoSED }, 
                {
                    headers: {
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'x-api-key': auth_token_iptv 
                };

                const pendenciasResponse = await axios.get(
                    'https://edusp-api.ip.tv/tms/task/todo/count?filter_expired=true', 
                    { headers: iptvDataHeaders }
                );
                tarefasPendentes = pendenciasResponse.data.todo || 0;
                tarefasExpiradas = pendenciasResponse.data.expired || 0;
            }
        } catch (e) {
            console.error('Erro na IP.TV (Handshake/Tarefas):', e.response?.data || e.message);
        }

        // ==========================================================
        // [#26] CONSULTA DE AVALIAÇÕES (SED)
        // ==========================================================
        try {
            const avaliacoesResponse = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${codigoAluno}&AnoLetivo=2026`, 
                { headers: sedAuthHeaders }
            );
            if (Array.isArray(avaliacoesResponse.data)) {
                totalAvaliacoes = avaliacoesResponse.data.length;
            }
        } catch (e) {
            console.error('Erro na rota #26 (Avaliações):', e.response?.data || e.message);
        }

        // Retorna a resposta (agora capturando os logs internos de erro)
        res.json({
            aluno: {
                codigo: codigoAluno,
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
        console.error('Erro crítico geral:', error.message);
        res.status(500).json({ error: 'Erro ao processar dados no servidor administrativo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF ativo e diagnosticando na porta ${PORT}`));
